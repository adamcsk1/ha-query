"""Keep shipped dashboard query examples within the real HA/query schemas."""
from pathlib import Path
import unittest

from homeassistant.util import yaml

from custom_components.ha_query import QUERY_SCHEMA
from custom_components.ha_query.query_language import validate_query


class ExampleTests(unittest.TestCase):
    def test_all_card_queries_validate(self):
        examples = sorted((Path(__file__).resolve().parents[1] / 'examples').glob('*.yaml'))
        self.assertTrue(examples)
        for path in examples:
            with self.subTest(example=path.name):
                config = yaml.load_yaml(str(path))
                self.assertEqual(config['type'], 'custom:ha-query-card')
                validate_query(QUERY_SCHEMA(config['query']))
                if 'state_labels' in config:
                    self.assertTrue(set(config['state_labels']) <= {'on', 'off', 'unknown', 'unavailable'})
