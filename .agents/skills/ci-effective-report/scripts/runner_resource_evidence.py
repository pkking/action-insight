"""Frozen v3 and governed report-side runner resource evidence; no I/O."""
import json
import re

from .card_quantity import physical_cards

# Explicit model inventory; not substring matching. Suffixes are raw collector values.
MODEL = r'(?:a2b1b3|a2b4|a2b1|a2b3|a3-800i|a3-800t|nightly-a3|310p|a2|a5|a3)'
MODEL_RE = re.compile(r'^linux-aarch64-(' + MODEL + r')$', re.I)
LABEL_RE = re.compile(r'^(linux-aarch64-' + MODEL + r')-([1-9]\d*)(?:-(cards?|dies?))?$', re.I)
# amd64-a5 hosts carry the same governed NPU card suffixes (verified: CANN images,
# USE_ASCEND=ON, test_suite nightly-acc-test-4-npu-a5); counts are raw cards like aarch64.
AMD64_A5_LABEL_RE = re.compile(r'^(linux-amd64-a5)-([1-9]\d*)(?:-(cards?|dies?))?$', re.I)
# ADR-041 family 1: host-tail labels like linux-aarch64-a3-800i-8-cn12-001 — the N
# suffix is the governed count, the trailing <host>-<ddd> names the physical host.
# Verified via job logs (npu-smi): a3-800i-8-cn12-001 exposes 4 NPUs x 2 dies = 8
# dies, so the N keeps the model family's existing unit semantics (a3 dies /2).
HOST_TAIL_LABEL_RE = re.compile(r'^(linux-aarch64-' + MODEL + r')-([1-9]\d*)(?:-(cards?|dies?))?-[a-z][a-z0-9]*-[0-9]{3}$', re.I)
# ADR-041 families 2/3: -fed-<N> across 5 repos (vllm-ascend/sglang/verl/recipes/
# mojo_opset), with optional repo-name infix before 'fed'. Verified via job logs:
# a3-800i-recipes-fed-4 exposes 2 NPUs x 2 dies (N=dies, /2 for a3 family).
FED_LABEL_RE = re.compile(r'^(linux-aarch64-' + MODEL + r')-(?:[a-z0-9]+-)*fed-([1-9]\d*)$', re.I)
NPU_HINT = re.compile(r'^(?:linux-aarch64-' + MODEL + r'|910b|910c|ascend|npu)(?:-|$)', re.I)
CPU = re.compile(r'^(?:linux-(?:aarch64|amd64|arm64)-cpu(?:-|$)|ubuntu(?:-|$)|macos(?:-|$)|windows(?:-|$))', re.I)
GPU = re.compile(r'^(?:nvidia(?:-|$)|amd(?:-|$)|gfx[0-9]|\d+-gpu(?:-|$)|gcp-a2-highgpu(?:-|$))', re.I)


def _v3_resource_evidence(job):
    try:
        labels = json.loads(job.get('labels_json') or '[]')
        if not isinstance(labels, list):
            labels = []
    except (TypeError, ValueError):
        labels = []
    labels = [x.lower() for x in labels if isinstance(x, str)]
    model = str(job.get('resource_model') or '').lower()
    count = job.get('resource_count')
    kinds = set()
    evidence = []
    for label in labels:
        match = LABEL_RE.fullmatch(label) or AMD64_A5_LABEL_RE.fullmatch(label) \
            or HOST_TAIL_LABEL_RE.fullmatch(label) or FED_LABEL_RE.fullmatch(label)
        if match:
            kinds.add('npu')
            unit = match.group(3) if match.lastindex and match.lastindex >= 3 else None
            lm, n = match.group(1), int(match.group(2))
            if unit and unit.startswith('die') and not lm in ('linux-aarch64-a3', 'linux-aarch64-a3-800i', 'linux-aarch64-a3-800t', 'linux-aarch64-nightly-a3'):
                evidence.append((lm, n, None, 'unsupported_unit'))
            else:
                a3 = lm in ('linux-aarch64-a3', 'linux-aarch64-a3-800i', 'linux-aarch64-a3-800t', 'linux-aarch64-nightly-a3')
                cards = (n + 1) // 2 if a3 and (not unit or unit.startswith('die')) else n
                evidence.append((lm, n, cards, 'explicit_cards' if unit and unit.startswith('card') else 'governed_suffix'))
        elif NPU_HINT.match(label):
            kinds.add('npu')
        if CPU.match(label):
            kinds.add('cpu')
        if GPU.match(label):
            kinds.add('gpu')
    if MODEL_RE.fullmatch(model):
        kinds.add('npu')
    elif re.fullmatch(r'linux-aarch64-cpu', model):
        kinds.add('cpu')
    # CPU platform labels commonly accompany an accelerator; only explicit cpu runner labels conflict.
    if 'npu' in kinds or 'gpu' in kinds:
        if not any(re.match(r'^linux-(?:aarch64|amd64|arm64)-cpu(?:-|$)', x) for x in labels) and model != 'linux-aarch64-cpu':
            kinds.discard('cpu')
    if len(kinds) > 1:
        return ('conflict', None, None, 'hardware_conflict')
    kind = next(iter(kinds), 'unknown')
    if kind != 'npu':
        return (kind, None, None, 'hardware_' + kind)
    if len(set(evidence)) > 1:
        return ('npu', None, None, 'label_conflict')
    if evidence:
        lm, raw, cards, reason = evidence[0]
        if (model and model != lm) or (count is not None and count != raw):
            return ('npu', lm, None, 'metadata_label_conflict')
        return ('npu', lm, cards, reason)
    if MODEL_RE.fullmatch(model) and isinstance(count, int) and not isinstance(count, bool) and count > 0:
        a3 = model in ('linux-aarch64-a3', 'linux-aarch64-a3-800i', 'linux-aarch64-a3-800t', 'linux-aarch64-nightly-a3')
        return ('npu', model, (count + 1) // 2 if a3 else count, 'governed_metadata')
    return ('npu', model or None, None, 'quantity_unknown')


def _current_standard_evidence(job):
    """Use frozen v3 for classification, then convert only original evidence."""
    evidence = _v3_resource_evidence(job)
    if evidence[0] != 'npu' or evidence[2] is None:
        return evidence
    try:
        labels = json.loads(job.get('labels_json') or '[]')
        if not isinstance(labels, list) or any(not isinstance(x, str) for x in labels):
            return ('npu', evidence[1], None, 'quantity_unknown')
    except (TypeError, ValueError):
        return ('npu', evidence[1], None, 'quantity_unknown')
    labels = [x.lower() for x in labels]
    matches = [m for x in labels for m in (LABEL_RE.fullmatch(x), AMD64_A5_LABEL_RE.fullmatch(x),
                                            HOST_TAIL_LABEL_RE.fullmatch(x), FED_LABEL_RE.fullmatch(x)) if m]
    # Unsupported accelerator-like suffixes cannot be rescued by metadata.
    governed = (LABEL_RE, AMD64_A5_LABEL_RE, HOST_TAIL_LABEL_RE, FED_LABEL_RE)
    if any(NPU_HINT.match(x) and not any(r.fullmatch(x) for r in governed) and not MODEL_RE.fullmatch(x) for x in labels):
        return ('npu', evidence[1], None, 'unsupported_label')
    count = job.get('resource_count')
    if count is not None and (type(count) is not int or count <= 0):
        return ('npu', evidence[1], None, 'metadata_label_conflict')
    if matches:
        match = matches[0]
        raw = int(match.group(2))
        unit = match.group(3) if match.lastindex and match.lastindex >= 3 else None
        unit = 'cards' if unit and unit.startswith('card') else 'dies' if unit else 'raw'
    else:
        raw, unit = count, 'raw'
    return (evidence[0], evidence[1], physical_cards(evidence[1], raw, unit), evidence[3])


def resource_evidence(job):
    """Apply scoped conventions to raw labels only; never normalize a normalized count."""
    repo, workflow = job.get('repo'), job.get('workflow')
    try:
        labels = json.loads(job.get('labels_json') or '[]')
        if not isinstance(labels, list) or any(not isinstance(x, str) for x in labels):
            return _current_standard_evidence(job)
    except (ValueError, TypeError):
        return _current_standard_evidence(job)
    labels = [x.lower() for x in labels]
    scope = (repo, workflow)
    hk_matches = [re.fullmatch(r'linux-aarch64-(a2b1b3|a2b1)-(1)-hk-001', x) for x in labels]
    hk_matches = [m for m in hk_matches if m]
    if scope == ('vllm-project/vllm-ascend', 'pr_test.yaml') and hk_matches:
        pattern = r'linux-aarch64-(?:a2b1b3|a2b1)-(1)-hk-001'
        model = 'linux-aarch64-' + hk_matches[0].group(1)
    elif scope in (('sgl-project/sglang', 'pr-test-npu.yml'), ('sgl-project/sglang', 'nightly-test-npu.yml')):
        # Family 5b (ADR-041): same-shape trailing-hyphen a3 labels on the nightly
        # workflow carry the same die semantics user-confirmed for pr-test-npu.yml.
        pattern = r'linux-aarch64-a3-(2|4|8|16)-'
        model = 'linux-aarch64-a3'
    elif scope == ('vllm-project/vllm-ascend', 'pr_test.yaml'):
        pattern = r'linux-aarch64-a3-(2|4|8)-'
        model = 'linux-aarch64-a3'
    elif scope == ('triton-lang/triton-ascend', 'ci.yml'):
        pattern = r'linux-amd64-a5-(1|2|4)'
        model = 'linux-amd64-a5'
    elif scope == ('tile-ai/tilelang', 'ci.yml'):
        # ascend job ("Test for AscendC"/"Test for PTO") runs on A5 NPU hosts with a
        # CANN container image (USE_ASCEND=ON); same hardware family as triton-ascend.
        pattern = r'linux-amd64-a5-(1|2|4|8)'
        model = 'linux-amd64-a5'
    else:
        return _current_standard_evidence(job)
    matches = [(x, re.fullmatch(pattern, x)) for x in labels]
    matches = [(x, m) for x, m in matches if m]
    if not matches:
        prefix = 'linux-amd64-a5-' if model == 'linux-amd64-a5' else 'linux-aarch64-a3-'
        if any(x.startswith(prefix) and not LABEL_RE.fullmatch(x) for x in labels):
            return ('npu', model, None, 'unsupported_scoped_label')
        return _current_standard_evidence(job)
    # Treat any other accelerator-like label, including malformed variants, as
    # ambiguous; do not let metadata or the old parser override conflicts.
    others = [x for x in labels if NPU_HINT.match(x) or re.match(r'^linux-amd64-a5(?:-|$)', x)]
    if len(matches) != 1 or len(others) != 1:
        return ('npu', None, None, 'label_conflict')
    metadata_model = job.get('resource_model')
    count = job.get('resource_count')
    raw = int(matches[0][1].group(1))
    if (metadata_model and str(metadata_model).lower() != model) or (count is not None and (type(count) is not int or count != raw)):
        return ('npu', model, None, 'metadata_label_conflict')
    if any(GPU.match(x) or re.match(r'^linux-(?:aarch64|amd64|arm64)-cpu(?:-|$)', x) for x in labels):
        return ('conflict', None, None, 'hardware_conflict')
    cards = physical_cards(model, raw, 'raw')
    return ('npu', model, cards, 'scoped_convention')


