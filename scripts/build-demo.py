#!/usr/bin/env python3
"""Builds the standalone Relic expression lab page (docs/demo/relic-lab.html) from the engine + built mascot data."""
import json, os, re
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
M = os.path.join(ROOT, 'ui', 'src', 'mascot')
engine = open(os.path.join(M, 'engine.js')).read().replace('export const', 'const').replace('export function', 'function')
css = open(os.path.join(M, 'mascot.css')).read()
relic = open(os.path.join(M, 'data', 'relic.json')).read()
tpl = open(os.path.join(ROOT, 'docs', 'demo', 'relic-lab.template.html')).read()
out = tpl.replace('/*__MASCOT_CSS__*/', css).replace('/*__ENGINE__*/', engine) \
         .replace('/*__RELIC__*/', relic)
open(os.path.join(ROOT, 'docs', 'demo', 'relic-lab.html'), 'w').write(out)
print('ok', len(out) // 1024, 'KB')
