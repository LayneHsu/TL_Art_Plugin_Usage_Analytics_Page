#!/usr/bin/env python3
"""从 ImportTool 动作注册表生成统计仓库的权威工具合同。"""

import argparse
import importlib.util
import json
from pathlib import Path


def _load_actions(importtool_root):
    source = (
        Path(importtool_root)
        / "PythonFile"
        / "v8_framework"
        / "core"
        / "usage_analytics"
        / "dialog_actions.py"
    )
    spec = importlib.util.spec_from_file_location("importtool_usage_actions", source)
    if spec is None or spec.loader is None:
        raise RuntimeError("无法加载 ImportTool 动作注册表")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _action(tool_key, action_key, page):
    return {
        "action_key": "{}.{}".format(tool_key, action_key),
        "display_name": action_key,
        "page": page,
        "introduced_version": "8.0.0",
        "retired_version": None,
        "accept_until": None,
        "display_state": "active",
    }


def build_registry(module):
    tools = []
    for tool_key, (class_name, page, display_name) in module.DIALOG_TOOLS.items():
        action_keys = ["open"]
        action_keys.extend(action for _method, action in module.DIALOG_ACTIONS.get(class_name, ()))
        actions = []
        for action_key in action_keys:
            if action_key not in [item["display_name"] for item in actions]:
                actions.append(_action(tool_key, action_key, page))
        tools.append(
            {
                "tool_key": tool_key,
                "display_name": display_name,
                "page": page,
                "introduced_version": "8.0.0",
                "retired_version": None,
                "accept_until": None,
                "display_state": "active",
                "actions": actions,
            }
        )

    known = {item["tool_key"] for item in tools}
    for tool_key, (action_key, page, display_name) in module.PAGE_ACTIONS.items():
        if tool_key in known:
            continue
        tools.append(
            {
                "tool_key": tool_key,
                "display_name": display_name,
                "page": page,
                "introduced_version": "8.0.0",
                "retired_version": None,
                "accept_until": None,
                "display_state": "active",
                "actions": [_action(tool_key, action_key, page)],
            }
        )

    return {
        "$schema": "./tool-registry.schema.json",
        "schema_version": "1.0.0",
        "registry_version": "1.0.0",
        "tools": tools,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--importtool-root", required=True)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    registry = build_registry(_load_actions(args.importtool_root))
    output = Path(__file__).resolve().parents[1] / "contracts" / "tool-registry.json"
    rendered = json.dumps(registry, ensure_ascii=False, indent=2) + "\n"
    if args.check:
        current = output.read_text(encoding="utf-8")
        if current != rendered:
            raise SystemExit("tool-registry.json 与 ImportTool 动作注册表不一致")
        print("registry parity ok ({} tools)".format(len(registry["tools"])))
        return
    output.write_text(rendered, encoding="utf-8")
    print("generated {} tools at {}".format(len(registry["tools"]), output))


if __name__ == "__main__":
    main()
