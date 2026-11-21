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
    # ADR-041 family 1: host-tail labels (<model>-<N>-<host>-<ddd>) are governed in
    # the general layer, so the hk-001 count survives outside the scoped workflow.
    assert resource_evidence({**job, 'workflow': 'other.yaml'})[2] == 1
    # Conflicting metadata still blocks the count.
    assert resource_evidence({**job, 'resource_count': 2})[2] is None


def test_host_tail_and_fed_families_governed():
    # ADR-041 families 1/2: verified via job logs (npu-smi device counts).
    # a3-800i-8-cn12-001: 8 dies over 4 NPUs -> 4 cards (A3 die semantics).
    assert resource_evidence({'labels_json': json.dumps(['linux-aarch64-a3-800i-8-cn12-001']),
                               'repo': 'Ascend/pytorch', 'workflow': 'a5-torch-npu-test.yml'})[2] == 4
    # a3-800i-recipes-fed-4: 4 dies over 2 NPUs -> 2 cards.
    assert resource_evidence({'labels_json': json.dumps(['linux-aarch64-a3-800i-recipes-fed-4']),
                               'repo': 'vllm-ascend/vllm-ascend-recipes', 'workflow': 'pr-recipe-verify.yml'})[2] == 2
    # a2 family: N stays cards (a2-mojo-fed-4 -> 4).
    assert resource_evidence({'labels_json': json.dumps(['linux-aarch64-a2-mojo-fed-4']),
                               'repo': 'XPU-Forces/mojo_opset', 'workflow': 'npu-910b.yml'})[2] == 4
    # a2b4 verified as physical cards: npu-smi shows 2 NPUs for a2b4-2.
    assert resource_evidence({'labels_json': json.dumps(['linux-aarch64-a2b4-2']),
                               'repo': 'vllm-ascend/vllm-ascend-recipes', 'workflow': 'pr-recipe-verify.yml'})[2] == 2


def test_model_summary_preserves_raw_and_static_is_not_converted():
    job = {'card_model': 'linux-aarch64-a3', 'card_count': 3}
    assert ci._model_summary([job]) == {'linux-aarch64-a3': 1.5}
    assert job['card_count'] == 3
    assert ci.workflow_resource_summary([job], {'A3': 8}) == 'A3 × 8卡'
