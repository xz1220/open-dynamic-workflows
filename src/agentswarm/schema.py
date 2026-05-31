"""Structured-output contract (L4-B): describe, extract, validate.

Heterogeneous agent CLIs cannot be *forced* to emit a tool call the way a
native API can, so reliability is built from three cooperating pieces:

1. :func:`describe_schema` turns a schema into an instruction appended to the
   prompt ("return only JSON shaped like this").
2. :func:`extract_json` pulls the most likely JSON value out of the free-text
   reply (fenced block, then a balanced ``{...}``/``[...]`` span, then the whole
   reply).
3. :func:`validate` checks the parsed value against the schema, returning a
   list of human-readable problems (empty == valid).

The bridge drives the retry loop around these. The schema language is a small,
dependency-free subset of JSON Schema; the author-facing constructors
(:func:`obj`, :func:`array`, ...) build those plain dicts so workflow scripts
stay readable.
"""

from __future__ import annotations

import json
from typing import Any

# --- author-facing constructors ---------------------------------------------
# These just build JSON-Schema dicts. Authors may also write the dicts by hand.


def obj(properties: dict[str, dict], required: list[str] | None = None) -> dict:
    """An object schema. By default every named property is required."""
    schema: dict[str, Any] = {"type": "object", "properties": properties}
    schema["required"] = list(properties) if required is None else required
    return schema


def array(items: dict, min_items: int | None = None) -> dict:
    schema: dict[str, Any] = {"type": "array", "items": items}
    if min_items is not None:
        schema["minItems"] = min_items
    return schema


def string() -> dict:
    return {"type": "string"}


def number() -> dict:
    return {"type": "number"}


def integer() -> dict:
    return {"type": "integer"}


def boolean() -> dict:
    return {"type": "boolean"}


def enum(*values: Any) -> dict:
    return {"enum": list(values)}


# --- prompt side -------------------------------------------------------------


def describe_schema(schema: dict) -> str:
    """Instruction text telling an agent to reply with matching JSON only."""
    pretty = json.dumps(schema, indent=2, ensure_ascii=False)
    return (
        "Respond with a single JSON value and nothing else — no prose, no code "
        "fence, no explanation. It must conform to this JSON Schema:\n"
        f"{pretty}"
    )


# --- extraction --------------------------------------------------------------


def extract_json(text: str) -> Any | None:
    """Best-effort recovery of a JSON value from a free-text agent reply."""
    for candidate in _candidates(text):
        try:
            return json.loads(candidate)
        except (json.JSONDecodeError, ValueError):
            continue
    return None


def _candidates(text: str):
    stripped = text.strip()
    fenced = _fenced_block(stripped)
    if fenced is not None:
        yield fenced
    span = _balanced_span(stripped)
    if span is not None:
        yield span
    yield stripped


def _fenced_block(text: str) -> str | None:
    """Contents of the first ```json (or bare ```) fenced block, if any."""
    fence = text.find("```")
    if fence == -1:
        return None
    after = text[fence + 3 :]
    newline = after.find("\n")
    if newline == -1:
        return None
    body = after[newline + 1 :]
    close = body.find("```")
    return body if close == -1 else body[:close]


def _balanced_span(text: str) -> str | None:
    """The first balanced {...} or [...] span, ignoring braces inside strings."""
    start = _first_of(text, "{[")
    if start == -1:
        return None
    open_ch = text[start]
    close_ch = "}" if open_ch == "{" else "]"
    depth = 0
    in_string = False
    escaped = False
    for i in range(start, len(text)):
        ch = text[i]
        if in_string:
            if escaped:
                escaped = False
            elif ch == "\\":
                escaped = True
            elif ch == '"':
                in_string = False
            continue
        if ch == '"':
            in_string = True
        elif ch == open_ch:
            depth += 1
        elif ch == close_ch:
            depth -= 1
            if depth == 0:
                return text[start : i + 1]
    return None


def _first_of(text: str, chars: str) -> int:
    positions = [text.find(c) for c in chars]
    positions = [p for p in positions if p != -1]
    return min(positions) if positions else -1


# --- validation --------------------------------------------------------------


def validate(value: Any, schema: dict, path: str = "$") -> list[str]:
    """Return a list of validation problems; empty means the value is valid."""
    if "enum" in schema:
        if value not in schema["enum"]:
            return [f"{path}: {value!r} is not one of {schema['enum']}"]
        return []

    expected = schema.get("type")
    if expected is None:
        return []
    checker = _CHECKERS.get(expected)
    if checker is None:
        return [f"{path}: unknown schema type {expected!r}"]
    return checker(value, schema, path)


def _check_object(value: Any, schema: dict, path: str) -> list[str]:
    if not isinstance(value, dict):
        return [f"{path}: expected object, got {_type_name(value)}"]
    errors: list[str] = []
    properties: dict[str, dict] = schema.get("properties", {})
    for key in schema.get("required", []):
        if key not in value:
            errors.append(f"{path}.{key}: required property is missing")
    for key, subschema in properties.items():
        if key in value:
            errors.extend(validate(value[key], subschema, f"{path}.{key}"))
    if schema.get("additionalProperties") is False:
        extra = sorted(set(value) - set(properties))
        if extra:
            errors.append(f"{path}: unexpected properties {extra}")
    return errors


def _check_array(value: Any, schema: dict, path: str) -> list[str]:
    if not isinstance(value, list):
        return [f"{path}: expected array, got {_type_name(value)}"]
    errors: list[str] = []
    min_items = schema.get("minItems")
    if min_items is not None and len(value) < min_items:
        errors.append(f"{path}: expected at least {min_items} items, got {len(value)}")
    items = schema.get("items")
    if items:
        for i, element in enumerate(value):
            errors.extend(validate(element, items, f"{path}[{i}]"))
    return errors


def _check_string(value: Any, _schema: dict, path: str) -> list[str]:
    return [] if isinstance(value, str) else [f"{path}: expected string, got {_type_name(value)}"]


def _check_integer(value: Any, _schema: dict, path: str) -> list[str]:
    ok = isinstance(value, int) and not isinstance(value, bool)
    return [] if ok else [f"{path}: expected integer, got {_type_name(value)}"]


def _check_number(value: Any, _schema: dict, path: str) -> list[str]:
    ok = isinstance(value, (int, float)) and not isinstance(value, bool)
    return [] if ok else [f"{path}: expected number, got {_type_name(value)}"]


def _check_boolean(value: Any, _schema: dict, path: str) -> list[str]:
    return [] if isinstance(value, bool) else [f"{path}: expected boolean, got {_type_name(value)}"]


def _check_null(value: Any, _schema: dict, path: str) -> list[str]:
    return [] if value is None else [f"{path}: expected null, got {_type_name(value)}"]


_CHECKERS = {
    "object": _check_object,
    "array": _check_array,
    "string": _check_string,
    "integer": _check_integer,
    "number": _check_number,
    "boolean": _check_boolean,
    "null": _check_null,
}


def _type_name(value: Any) -> str:
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, str):
        return "string"
    if isinstance(value, list):
        return "array"
    if isinstance(value, dict):
        return "object"
    if isinstance(value, int):
        return "integer"
    if isinstance(value, float):
        return "number"
    return type(value).__name__
