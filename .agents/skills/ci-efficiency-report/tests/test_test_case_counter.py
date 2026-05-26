import importlib.util
import os
import sys
import tempfile
import unittest
from pathlib import Path


COUNTER_PATH = Path(__file__).resolve().parents[1] / "scripts" / "test_case_counter.py"
SPEC = importlib.util.spec_from_file_location("test_case_counter", COUNTER_PATH)
COUNTER = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
sys.modules[SPEC.name] = COUNTER
SPEC.loader.exec_module(COUNTER)


class TestClassifyHardwareFromRunnerLabels(unittest.TestCase):
    def test_ascend_labels(self):
        for labels in [["npu"], ["ascend"], ["cann"], ["npu-arm"], ["self-hosted", "npu", "linux"]]:
            self.assertEqual(COUNTER.classify_hardware_from_runner_labels(labels), "ascend")

    def test_nvidia_labels(self):
        for labels in [["cuda"], ["gpu"], ["nvidia"], ["self-hosted", "cuda", "linux"]]:
            self.assertEqual(COUNTER.classify_hardware_from_runner_labels(labels), "nvidia")

    def test_x86_64_with_cuda(self):
        self.assertEqual(
            COUNTER.classify_hardware_from_runner_labels(["x86_64", "cuda"]),
            "nvidia",
        )

    def test_unknown_labels(self):
        for labels in [["ubuntu-latest"], ["linux", "x64"], ["self-hosted"], []]:
            self.assertIsNone(COUNTER.classify_hardware_from_runner_labels(labels))

    def test_ascend_priority_over_nvidia(self):
        self.assertEqual(
            COUNTER.classify_hardware_from_runner_labels(["npu", "cuda"]),
            "ascend",
        )


class TestClassifyHardwareFromDirectory(unittest.TestCase):
    def test_ascend_dirs(self):
        for path in ["tests/ascend/test_foo.py", "tests/npu/bar_test.py", "tests/cann/utils.py"]:
            self.assertEqual(COUNTER.classify_hardware_from_directory(path), "ascend")

    def test_nvidia_dirs(self):
        for path in ["tests/cuda/test_foo.py", "tests/gpu/bar_test.py", "tests/nvidia/utils.py"]:
            self.assertEqual(COUNTER.classify_hardware_from_directory(path), "nvidia")

    def test_unknown_dirs(self):
        for path in ["tests/test_foo.py", "src/main.py", "docs/readme.md"]:
            self.assertIsNone(COUNTER.classify_hardware_from_directory(path))


class TestClassifyHardwareFromJobName(unittest.TestCase):
    def test_ascend_names(self):
        for name in ["test-ascend", "npu-tests", "cann-validation", "run-npu-arm"]:
            self.assertEqual(COUNTER.classify_hardware_from_job_name(name), "ascend")

    def test_nvidia_names(self):
        for name in ["cuda-tests", "gpu-validation", "nvidia-smi-check", "run-cuda-11"]:
            self.assertEqual(COUNTER.classify_hardware_from_job_name(name), "nvidia")

    def test_unknown_names(self):
        for name in ["lint", "build", "test", "deploy"]:
            self.assertIsNone(COUNTER.classify_hardware_from_job_name(name))


class TestParseWorkflowToTestMapping(unittest.TestCase):
    def test_parses_workflow_with_test_steps(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            wf_dir = os.path.join(tmpdir, ".github", "workflows")
            os.makedirs(wf_dir)
            wf_file = os.path.join(wf_dir, "ci.yml")
            with open(wf_file, "w") as f:
                f.write("""
name: CI
jobs:
  test-ascend:
    runs-on: [self-hosted, npu]
    steps:
      - run: pytest tests/ascend/
  test-cuda:
    runs-on: [self-hosted, cuda]
    steps:
      - run: python -m pytest tests/cuda/test_foo.py
""")

            mapping = COUNTER.parse_workflow_to_test_mapping(tmpdir)

            self.assertIn("CI", mapping)
            self.assertIn("test-ascend", mapping["CI"])
            self.assertIn("test-cuda", mapping["CI"])
            self.assertEqual(mapping["CI"]["test-ascend"]["hardware_hint"], "ascend")
            self.assertEqual(mapping["CI"]["test-cuda"]["hardware_hint"], "nvidia")

    def test_returns_empty_for_no_workflows_dir(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            mapping = COUNTER.parse_workflow_to_test_mapping(tmpdir)
            self.assertEqual(mapping, {})

    def test_returns_empty_for_invalid_yaml(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            wf_dir = os.path.join(tmpdir, ".github", "workflows")
            os.makedirs(wf_dir)
            with open(os.path.join(wf_dir, "broken.yml"), "w") as f:
                f.write("key: [unclosed\n  - item: {bad")
            mapping = COUNTER.parse_workflow_to_test_mapping(tmpdir)
            self.assertEqual(mapping, {})


class TestCountTestFilesForJob(unittest.TestCase):
    def test_counts_test_files_in_directory(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            tests_dir = os.path.join(tmpdir, "tests")
            os.makedirs(tests_dir)
            for name in ["test_foo.py", "test_bar.py", "foo_test.py", "utils.py"]:
                with open(os.path.join(tests_dir, name), "w") as f:
                    f.write("# test")

            result = COUNTER.count_test_files_for_job(
                repo_path=tmpdir,
                workflow_name="CI",
                job_name="test",
                runner_labels=["self-hosted", "npu"],
                job_steps=[{"run": "pytest tests/"}],
            )

            self.assertEqual(result["ascend_count"], 3)
            self.assertEqual(result["nvidia_count"], 0)

    def test_counts_with_nvidia_hardware(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            tests_dir = os.path.join(tmpdir, "tests")
            os.makedirs(tests_dir)
            for name in ["test_foo.py", "test_bar.py"]:
                with open(os.path.join(tests_dir, name), "w") as f:
                    f.write("# test")

            result = COUNTER.count_test_files_for_job(
                repo_path=tmpdir,
                workflow_name="CI",
                job_name="test-cuda",
                runner_labels=["self-hosted", "cuda"],
                job_steps=[{"run": "pytest tests/"}],
            )

            self.assertEqual(result["ascend_count"], 0)
            self.assertEqual(result["nvidia_count"], 2)

    def test_handles_no_test_files(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            result = COUNTER.count_test_files_for_job(
                repo_path=tmpdir,
                workflow_name="CI",
                job_name="test",
                runner_labels=["self-hosted", "npu"],
                job_steps=[],
            )

            self.assertEqual(result["ascend_count"], 0)
            self.assertEqual(result["nvidia_count"], 0)

    def test_handles_no_steps(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            tests_dir = os.path.join(tmpdir, "tests")
            os.makedirs(tests_dir)
            with open(os.path.join(tests_dir, "test_foo.py"), "w") as f:
                f.write("# test")

            result = COUNTER.count_test_files_for_job(
                repo_path=tmpdir,
                workflow_name="CI",
                job_name="test",
                runner_labels=["self-hosted", "npu"],
                job_steps=[],
            )

            self.assertEqual(result["ascend_count"], 1)
            self.assertEqual(result["nvidia_count"], 0)

    def test_counts_ascend_directory_files(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            ascend_dir = os.path.join(tmpdir, "tests", "ascend")
            os.makedirs(ascend_dir)
            with open(os.path.join(ascend_dir, "test_npu.py"), "w") as f:
                f.write("# test")

            result = COUNTER.count_test_files_for_job(
                repo_path=tmpdir,
                workflow_name="CI",
                job_name="test",
                runner_labels=["self-hosted"],
                job_steps=[{"run": "pytest tests/ascend/"}],
            )

            self.assertEqual(result["ascend_count"], 1)
            self.assertEqual(result["nvidia_count"], 0)


class TestComputeTestCaseStats(unittest.TestCase):
    def test_returns_zero_for_empty_rows(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            stats = COUNTER.compute_test_case_stats(tmpdir, [])
            self.assertEqual(stats, {"total": 0, "ascend": 0, "nvidia": 0})

    def test_counts_from_job_raw_rows(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            wf_dir = os.path.join(tmpdir, ".github", "workflows")
            os.makedirs(wf_dir)
            with open(os.path.join(wf_dir, "ci.yml"), "w") as f:
                f.write("""
name: CI
jobs:
  test:
    runs-on: [self-hosted, npu]
    steps:
      - run: pytest tests/
""")
            tests_dir = os.path.join(tmpdir, "tests")
            os.makedirs(tests_dir)
            for name in ["test_a.py", "test_b.py"]:
                with open(os.path.join(tests_dir, name), "w") as f:
                    f.write("# test")

            job_raw_rows = [
                {
                    "workflow_name": "CI",
                    "job_name": "test",
                    "runner_labels": "self-hosted, npu",
                },
            ]

            stats = COUNTER.compute_test_case_stats(tmpdir, job_raw_rows)

            self.assertEqual(stats["ascend"], 2)
            self.assertEqual(stats["nvidia"], 0)
            self.assertEqual(stats["total"], 2)


if __name__ == "__main__":
    unittest.main()
