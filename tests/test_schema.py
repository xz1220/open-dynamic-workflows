"""L4-B: structured-output describe / extract / validate."""

from __future__ import annotations

from agentswarm import schema


def test_describe_includes_the_schema():
    text = schema.describe_schema(schema.obj({"name": schema.string()}))
    assert "JSON" in text
    assert "name" in text


def test_extract_from_fenced_block():
    reply = "Sure, here it is:\n```json\n{\"a\": 1}\n```\nDone."
    assert schema.extract_json(reply) == {"a": 1}


def test_extract_balanced_object_amid_prose():
    reply = 'The answer is {"a": 1, "b": [2, 3]} as requested.'
    assert schema.extract_json(reply) == {"a": 1, "b": [2, 3]}


def test_extract_ignores_braces_inside_strings():
    reply = 'note {"text": "a } closing brace", "ok": true}'
    assert schema.extract_json(reply) == {"text": "a } closing brace", "ok": True}


def test_extract_whole_text_when_pure_json():
    assert schema.extract_json('[1, 2, 3]') == [1, 2, 3]


def test_extract_returns_none_on_garbage():
    assert schema.extract_json("no json here at all") is None


def test_validate_object_required_and_types():
    spec = schema.obj({"name": schema.string(), "count": schema.integer()})
    assert schema.validate({"name": "x", "count": 3}, spec) == []
    assert schema.validate({"name": "x"}, spec)  # missing 'count'
    assert schema.validate({"name": 1, "count": 3}, spec)  # wrong type


def test_validate_array_items_and_min_items():
    spec = schema.array(schema.integer(), min_items=2)
    assert schema.validate([1, 2, 3], spec) == []
    assert schema.validate([1], spec)  # too few
    assert schema.validate([1, "two"], spec)  # bad element


def test_validate_enum():
    spec = schema.enum("low", "high")
    assert schema.validate("low", spec) == []
    assert schema.validate("mid", spec)


def test_integer_rejects_bool():
    # bool is an int subclass in Python; the schema must not accept it.
    assert schema.validate(True, schema.integer())


def test_validate_nested_paths_point_at_the_problem():
    spec = schema.obj({"items": schema.array(schema.obj({"id": schema.integer()}))})
    problems = schema.validate({"items": [{"id": "nope"}]}, spec)
    assert problems
    assert "items[0].id" in problems[0]
