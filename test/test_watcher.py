#!/usr/bin/env python3
"""
Tests for watcher_v2.py helper functions using unittest.
Run: /c/Python312/python.exe test/test_watcher.py
"""
import sys
import os
import unittest

# Add bridges/ to path
BRIDGES_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', 'bridges'))
sys.path.insert(0, BRIDGES_DIR)

import importlib.util
spec = importlib.util.spec_from_file_location(
    'watcher_v2',
    os.path.join(BRIDGES_DIR, 'watcher_v2.py')
)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

_read = mod._read_deploy_backlog_field
_build = mod._build_hermes_idle_prompt


class TestReadDeployBacklogField(unittest.TestCase):

    def test_reads_blocker(self):
        result = _read("Deploy blocker")
        self.assertIsNotNone(result)
        self.assertIn("None", result)

    def test_reads_d067(self):
        result = _read("D-067 batch")
        self.assertIsNotNone(result)
        self.assertIn("shipped", result.lower())

    def test_reads_prod_sha(self):
        result = _read("Prod SHA")
        self.assertIsNotNone(result)
        self.assertGreater(len(result), 5)

    def test_nonexistent_keyword_returns_none(self):
        result = _read("THIS_DOES_NOT_EXIST_000")
        self.assertIsNone(result)

    def test_non_table_rows_not_matched(self):
        # "D-068 verification" appears in instructions (non-table rows)
        result = _read("D-068 verification")
        self.assertIsNone(result)

    def test_reads_d090_field(self):
        result = _read("D-090")
        self.assertIsNotNone(result)


class TestBuildHermesIdlePrompt(unittest.TestCase):

    def test_contains_live_state(self):
        prompt = _build()
        self.assertIn("blocker:", prompt.lower())
        self.assertIn("D-067 batch:", prompt)

    def test_no_hardcoded_stale_state(self):
        prompt = _build()
        stale = [
            "D-067e shipped, only D-067d remains",
            "D-068 verification still blocks",
            "or exact blocker",
        ]
        for phrase in stale:
            self.assertNotIn(phrase, prompt)

    def test_has_actionable_directive(self):
        prompt = _build()
        self.assertIn("highest-leverage", prompt)
        self.assertIn("do not ask", prompt.lower())

    def test_is_callable_not_static(self):
        self.assertTrue(callable(mod._build_hermes_idle_prompt))
        self.assertIs(mod.AGENT_IDLE_PROMPT["hermes"], mod._build_hermes_idle_prompt)

    def test_contains_watcher_version(self):
        prompt = _build()
        self.assertIn("v2.16", prompt)


if __name__ == '__main__':
    unittest.main()
