from __future__ import annotations

import json
from typing import Any

from ...infra.io_utils import read_text
from ...infra.paths import DEFAULT_MAP_EXTRACT_EDGE_RESPONSE_SCHEMA, DEFAULT_MAP_EXTRACT_NODE_RESPONSE_SCHEMA


MAP_EXTRACT_NODE_RESPONSE_SCHEMA: dict[str, Any] = json.loads(
    read_text(DEFAULT_MAP_EXTRACT_NODE_RESPONSE_SCHEMA)
)

MAP_EXTRACT_EDGE_RESPONSE_SCHEMA: dict[str, Any] = json.loads(
    read_text(DEFAULT_MAP_EXTRACT_EDGE_RESPONSE_SCHEMA)
)
