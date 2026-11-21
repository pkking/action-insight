"""Report-side conversion of validated raw runner quantities to physical cards.

This module does not parse labels or infer units. Callers must supply the
original positive integer and its explicit interpretation, never a converted
value. None represents unsupported or invalid evidence.
"""

A3_MODELS = frozenset({
    'linux-aarch64-a3', 'linux-aarch64-a3-800i',
    'linux-aarch64-a3-800t', 'linux-aarch64-nightly-a3',
})
CARD_MODELS = frozenset({
    'linux-aarch64-a2', 'linux-aarch64-a2b1', 'linux-aarch64-a2b3',
    'linux-aarch64-a2b1b3', 'linux-aarch64-a2b4', 'linux-aarch64-310p',
    'linux-aarch64-a5', 'linux-amd64-a5', 'linux-aarch64-910b',
})
RULE_VERSION = 'governed-runner-v5-user-confirmed-card-units'
RULE_SOURCE = 'user confirmation: A2/A5/310P N cards; A3 N/2 cards'


def physical_cards(model, raw, unit):
    """Convert raw integer with unit 'raw', 'dies' or 'cards'; else unknown."""
    if type(raw) is not int or raw <= 0 or unit not in ('raw', 'dies', 'cards'):
        return None
    if model in A3_MODELS:
        return raw if unit == 'cards' else raw / 2
    if model in CARD_MODELS and unit in ('raw', 'cards'):
        return raw
    return None
