import importlib.util
import json
import sys
from pathlib import Path

SKILL = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SKILL))
from scripts.card_quantity import physical_cards
from scripts.runner_resource_evidence import resource_evidence

spec = importlib.util.spec_from_file_location('ci_analyze_shared_test', SKILL / 'scripts/ci_analyze.py')
ci = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ci)


def test_a3_raw_and_explicit_cards():
    model = 'linux-aarch64-a3'
    assert physical_cards(model, 1, 'raw') == .5
    assert physical_cards(model, 3, 'raw') == 1.5
    assert physical_cards(model, 3, 'cards') == 3
    for suffix, expected in [('1', .5), ('3', 1.5), ('3-cards', 3)]:
        job = {'labels': [f'{model}-{suffix}']}
        assert ci._resource_type_and_cards(job) == ('A3', expected)


def test_scoped_hk_and_conflict():
    job = {'labels_json': json.dumps(['linux-aarch64-a2b1-1-hk-001']),
           'repo': 'vllm-project/vllm-ascend', 'workflow': 'pr_test.yaml'}
    assert resource_evidence(job)[2] == 1
    assert resource_evidence({**job, 'workflow': 'other.yaml'})[2] is None
    assert resource_evidence({**job, 'resource_count': 2})[2] is None


def test_model_summary_preserves_raw_and_static_is_not_converted():
    job = {'card_model': 'linux-aarch64-a3', 'card_count': 3}
    assert ci._model_summary([job]) == {'linux-aarch64-a3': 1.5}
    assert job['card_count'] == 3
    assert ci.workflow_resource_summary([job], {'A3': 8}) == 'A3 × 8卡'
