import test from 'node:test';
import assert from 'node:assert/strict';
import { checkScript, describeFindings, pathProblem, scriptHash, MAX_SCRIPT_BYTES, ALLOWED_MODULES } from '../src/core/blender/static-check.js';

const DIR = '/home/u/.legion/ws/sculptor/blender-exports';
const WINDIR = 'C:\\Users\\Dan\\.legion\\ws\\sculptor\\blender-exports';
const check = (src: string, dirs: string[] = [DIR]) => checkScript(src, { allowedDirs: dirs });
const rules = (src: string, dirs?: string[]) => check(src, dirs).findings.map((f) => f.rule);
const blocked = (src: string, rule?: string, dirs?: string[]) => {
  const r = check(src, dirs);
  assert.equal(r.ok, false, `expected blocked:\n${src}`);
  if (rule) assert.ok(r.findings.some((f) => f.rule === rule), `expected rule ${rule}, got ${JSON.stringify(r.findings.map((f) => f.rule))} for:\n${src}`);
};
const fine = (src: string, dirs?: string[]) => {
  const r = check(src, dirs);
  assert.deepEqual(r.findings, [], `expected clean:\n${src}\n${describeFindings(r)}`);
};

test('realistic scripts pass', () => {
  fine(`import bpy
import bmesh
from mathutils import Vector, Matrix
import math

bpy.ops.object.select_all(action='DESELECT')
bpy.ops.mesh.primitive_cube_add(size=2, location=(0, 0, 1))
cube = bpy.context.active_object
cube.name = "Crate"
mod = cube.modifiers.new(name="Bevel", type='BEVEL')
mod.width = 0.05
bpy.context.scene.unit_settings.system = 'METRIC'
mat = bpy.data.materials.new("Wood")
mat.use_nodes = True
mat.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.4, 0.2, 0.1, 1)
cube.data.materials.append(mat)
for i, v in enumerate(cube.data.vertices):
    v.co.z += math.sin(i) * 0.01
print("done", len(cube.data.vertices))
`);
  fine(`import bpy
class MyOp(bpy.types.Operator):
    bl_idname = "object.my_op"
    bl_label = "My op"
    def __init__(self):
        super().__init__()
    def execute(self, context):
        return {'FINISHED'}
bpy.utils.register_class(MyOp)
`);
  fine(`import bpy
def make(name, **kw):
    bpy.ops.mesh.primitive_uv_sphere_add(radius=1)
    return bpy.context.active_object
x = make("a", size=2)
path = [(0, 0, 0), (1, 1, 1)]
output = {}
file = 3
vals = [getattr(x, "location"), hasattr(x, "rotation_euler")]
setattr(x, "name", "ball")
bm = bmesh.new()
`.replace('bmesh.new()', 'None'));
  fine(`import bpy
for ob in bpy.context.scene.objects:
    if ob.type == 'MESH':
        ob.select_set(True)
msg = f"{len(bpy.data.objects)} objects, active {bpy.context.view_layer.objects.active.name!r:>10}"
print(msg)
`);
});

test('imports: only the allowlist', () => {
  for (const bad of ['import os', 'import sys', 'import subprocess', 'import socket', 'import ctypes', 'import importlib', 'import shutil',
    'import pathlib', 'import urllib.request', 'import http.client', 'import pickle', 'import io', 'import builtins', 'import base64',
    'import tempfile', 'import numpy as np', 'import os.path', 'import os, math', 'import math, os', 'from os import system', 'from os import *',
    'from os.path import join', 'from importlib import import_module', 'from . import x', 'from .. import y', 'import threading',
    'import multiprocessing', 'import webbrowser', 'import requests', 'import addon_utils', 'import zipfile', 'import codecs',
    'import inspect', 'import gc', 'import platform', 'import runpy', 'import logging', 'import ast', 'import bpy.ops', 'from bpy.ops import wm',
    'from bpy import ops', 'import math as os', 'import bpy_types2']) {
    blocked(bad, undefined);
  }
  fine('import bpy, bmesh, math, random\nfrom mathutils import Vector\nimport bpy.types\n');
  fine('from __future__ import annotations\nimport bpy');
  blocked('x = 1; import os', 'import');
  blocked('if True: import os', 'import');
  blocked('if True:\n    import os\n', 'import');
  blocked('try:\n    import subprocess\nexcept ImportError:\n    pass', 'import');
  blocked('from bpy_extras.io_utils import os', 'banned-name');
  blocked('from random import _os', 'import');
  blocked('from bpy import _bpy', 'import');
});

test('obfuscated imports and dynamic code', () => {
  blocked("__import__('os').system('calc')", 'dunder-name');
  blocked("__import__('o' + 's')", 'dunder-name');
  blocked("getattr(__builtins__, '__import__')('os')", 'dunder-name');
  blocked("__builtins__['__import__']('os')", 'dunder-name');
  blocked("globals()['__builtins__']", 'banned-name');
  blocked("locals()", 'banned-name');
  blocked("vars(bpy)", 'banned-name');
  blocked("eval('1+1')", 'banned-name');
  blocked("exec('import os')", 'banned-name');
  blocked("compile('1', 'f', 'eval')", 'banned-name');
  blocked("e = eval\ne('1')", 'banned-name');
  blocked("f = [exec][0]", 'banned-name');
  blocked("import bpy\nimport base64\nexec(base64.b64decode('aW1wb3J0IG9z'))", 'banned-name');
  blocked("exec(__import__('base64').b64decode('aW1wb3J0IG9z'))", 'banned-name');
  blocked("import importlib\nimportlib.import_module('os')", 'import');
  blocked("bpy.utils.os.system('x')", 'banned-attribute');
  blocked("import bpy\nbpy.utils.os.system('x')", 'banned-attribute');
  blocked("import random\nrandom._os.system('x')", 'private-attribute');
  blocked("x = ().__class__.__bases__[0].__subclasses__()", 'dunder-attribute');
  blocked("f = lambda: 0\nf.__globals__['os']", 'dunder-attribute');
  blocked("(lambda: 0).__code__", 'dunder-attribute');
  blocked("x.__dict__", 'dunder-attribute');
  blocked("x.__getattribute__('os')", 'dunder-attribute');
  blocked("x.__class__", 'dunder-attribute');
  blocked("def __getattr__(n): pass", 'dunder-name');
  blocked("x = __loader__", 'dunder-name');
  blocked("x = __file__", 'dunder-name');
  blocked("raise SystemExit", 'banned-name');
  blocked("exit()", 'banned-name');
  blocked("quit()", 'banned-name');
  blocked("breakpoint()", 'banned-name');
  blocked("input('x')", 'banned-name');
  blocked("import bpy\nbpy.app.handlers.load_post.append(f)", 'banned-attribute');
  blocked("bpy.app.timers.register(f)", 'banned-attribute');
  blocked("bpy.app.driver_namespace['x'] = 1", 'banned-attribute');
  blocked("fc = obj.driver_add('location', 0)\nfc.driver.expression = \"__import__('os')\"", 'banned-attribute');
  blocked("bpy.context.preferences.addons['x']", 'banned-attribute');
  blocked("bpy.data.libraries.load('/etc/x.blend')", 'banned-attribute');
  blocked("with bpy.data.libraries.load(p) as (a, b): pass", 'banned-attribute');
  blocked("time.sleep(5)", 'banned-attribute');
  blocked("img.unpack(method='WRITE_LOCAL')", 'banned-attribute');
  blocked("operator.attrgetter('a.b')(x)", 'banned-attribute');
  blocked("operator.methodcaller('system', 'x')(y)", 'banned-attribute');
  blocked("'{0.__class__}'.format(x)", 'dunder-string');
  blocked("'{0.__init__.__globals__}'.format(x)", 'dunder-string');
  blocked("string.Formatter().get_field('0.__class__', [x], {})", 'banned-attribute');
  blocked("'{0}'.format_map(x)", 'banned-attribute');
});

test('os.system style calls are blocked, harmless properties with the same name are not', () => {
  blocked("thing.system('x')", 'banned-attribute');
  blocked("thing.popen('x')", 'banned-attribute');
  blocked("thing.spawnl(1, 2)", 'banned-attribute');
  blocked("thing.startfile('x')", 'banned-attribute');
  fine("scene.unit_settings.system = 'METRIC'\nv = scene.unit_settings.system");
});

test('unicode and escape tricks', () => {
  blocked("ｅｖａｌ('1')", 'banned-name'); // fullwidth letters: Python normalises identifiers to NFKC
  blocked("ｅxec('1')", 'banned-name');
  blocked("import ｏｓ", 'import');
  blocked("x = 1\u200b+ 2", 'syntax'); // zero width space
  blocked("e\u200bval('1')", 'syntax');
  blocked("x = 5 $ 3", 'syntax');
  blocked("x = `1`", 'syntax');
  blocked("\x00import os", 'control');
  blocked("# -*- coding: rot13 -*-\nvpbeg bf", 'encoding');
  fine("# -*- coding: utf-8 -*-\nimport bpy");
  blocked("s = 'unterminated", 'syntax');
  blocked("x = (1, 2", 'syntax');
  blocked("x = 1)", 'syntax');
  blocked("x = a \\ b", 'syntax');
  // names inside f-strings are code
  blocked("x = f\"{__import__('os').getcwd()}\"", 'dunder-name');
  blocked("x = f\"{eval('1')}\"", 'banned-name');
  blocked("x = f'{open}'", 'banned-name');
  blocked("x = f\"{x:{eval('1')}}\"", 'banned-name');
  blocked("x = f\"{{}} {'a'.__class__}\"", 'dunder-attribute');
  blocked("x = f\"{\"", 'syntax');
  fine("x = f\"{{literal}} {1 + 2:>5} {name!r}\"");
  // a string that merely mentions things is fine
  fine("print('use os.system and eval carefully')");
  fine("# import os\nx = 1  # exec(code)");
  fine('"""docstring with import os and eval(x)"""\nx = 1');
});

test('getattr family: only direct calls with a literal safe name', () => {
  fine("getattr(obj, 'location')");
  fine("getattr(obj, 'location', None)");
  fine("setattr(obj, 'name', 'x')");
  blocked("getattr(obj, name)", 'getattr');
  blocked("getattr(obj, 'a' + 'b')", 'getattr');
  blocked("getattr(obj, '_' + 'x')", 'getattr');
  blocked("getattr(obj, f'{x}')", 'getattr');
  blocked("getattr(obj, ''.join(['sys', 'tem']))", 'getattr');
  blocked("getattr(os, 'system')", 'banned-name');
  blocked("getattr(obj, 'system')('x')", 'getattr');
  blocked("getattr(obj, '__class__')", 'getattr');
  blocked("getattr(obj, '__dict__')", 'getattr');
  blocked("getattr(obj, '_private')", 'getattr');
  blocked("getattr(obj, 'expression')", 'getattr');
  blocked("getattr(bpy, 'ops')", 'getattr');
  blocked("getattr(bpy.app, 'handlers')", 'getattr');
  blocked("getattr(obj, b'abc')", 'getattr');
  blocked("f = getattr\nf(obj, 'x')", 'getattr');
  blocked("list(map(getattr, objs, names))", 'getattr');
  blocked("hasattr(obj, name)", 'getattr');
  blocked("delattr(obj, name)", 'getattr');
  blocked("setattr(obj, name, 1)", 'getattr');
  blocked("getattr(getattr(bpy, 'ops'), 'wm')", 'getattr');
});

test('string concatenation does not hide names', () => {
  blocked("x = 'ev' + 'al'\ngetattr(__builtins__, x)", 'dunder-name');
  blocked("getattr(bpy, 'o' + 'ps')", 'getattr');
  blocked("globals()['ev' + 'al']('1')", 'banned-name');
});

test('file paths: only literals inside the allowed folder, //-relative, or LEGION_EXPORT_DIR + "/name"', () => {
  fine(`bpy.ops.export_scene.gltf(filepath="${DIR}/chair.glb")`);
  fine(`bpy.ops.export_scene.gltf(filepath='${DIR}/sub/chair.glb', export_format='GLB')`);
  fine('bpy.ops.export_scene.gltf(filepath=LEGION_EXPORT_DIR + "/chair.glb")');
  fine('bpy.ops.export_scene.gltf(filepath=LEGION_EXPORT_DIR)');
  fine('bpy.ops.wm.save_as_mainfile(filepath="//backup.blend", copy=True)');
  fine('bpy.context.scene.render.filepath = LEGION_EXPORT_DIR + "/shot.png"');
  fine(`bpy.context.scene.render.filepath = "${DIR}/shot.png"`);
  fine('bpy.context.scene.render.filepath = ""');
  fine(`img = bpy.data.images.load("${DIR}/tex.png")`);
  fine('bpy.ops.wm.save_mainfile()');
  fine(`bpy.ops.import_scene.fbx(filepath="${DIR}" "/in.fbx")`);
  // outside
  blocked('bpy.ops.export_scene.gltf(filepath="/etc/cron.d/x.glb")', 'path');
  blocked('bpy.ops.export_scene.gltf(filepath="/home/u/.ssh/authorized_keys")', 'path');
  blocked('bpy.ops.wm.save_as_mainfile(filepath="C:\\\\Windows\\\\System32\\\\x.blend")', 'path');
  blocked('bpy.ops.wm.save_as_mainfile(filepath="C:/Users/Dan/Startup/x.blend")', 'path');
  blocked('bpy.ops.export_scene.gltf(filepath="relative.glb")', 'path');
  blocked('bpy.ops.export_scene.gltf(filepath="x.glb")', 'path');
  blocked(`bpy.ops.export_scene.gltf(filepath="${DIR}/../../.bashrc")`, 'path');
  blocked(`bpy.ops.export_scene.gltf(filepath="${DIR}/../x.glb")`, 'path');
  blocked('bpy.ops.export_scene.gltf(filepath="//../../x.glb")', 'path');
  blocked('bpy.ops.export_scene.gltf(filepath="//")', 'path');
  blocked('bpy.ops.export_scene.gltf(filepath="\\\\\\\\server\\\\share\\\\x.glb")', 'path');
  blocked('bpy.ops.export_scene.gltf(filepath="~/x.glb")', 'path');
  blocked('bpy.ops.export_scene.gltf(filepath="$HOME/x.glb")', 'path');
  blocked('bpy.ops.export_scene.gltf(filepath="%APPDATA%\\\\x.glb")', 'path');
  blocked('bpy.ops.export_scene.gltf(filepath="file:///etc/passwd")', 'path');
  blocked(`bpy.ops.export_scene.gltf(filepath="${DIR}-evil/x.glb")`, 'path');
  blocked(`bpy.ops.export_scene.gltf(filepath="${DIR}x.glb")`, 'path');
  // not literal
  blocked('p = "/etc/passwd"\nbpy.ops.export_scene.gltf(filepath=p)', 'path');
  blocked('bpy.ops.export_scene.gltf(filepath="/e" + "tc/x")', 'path');
  blocked(`bpy.ops.export_scene.gltf(filepath="${DIR}/" + name)`, 'path');
  blocked('bpy.ops.export_scene.gltf(filepath=f"{d}/x.glb")', 'path');
  blocked('bpy.ops.export_scene.gltf(filepath="%s/x.glb" % d)', 'path');
  blocked('bpy.ops.export_scene.gltf(filepath="{}/x".format(d))', 'path');
  blocked('bpy.ops.export_scene.gltf(filepath=bpy.path.abspath("//x.glb"))', 'path');
  blocked('bpy.ops.export_scene.gltf(filepath=LEGION_EXPORT_DIR + "x.glb")', 'path');
  blocked('bpy.ops.export_scene.gltf(filepath=LEGION_EXPORT_DIR + "/../x.glb")', 'path');
  blocked('bpy.ops.export_scene.gltf(filepath=LEGION_EXPORT_DIR + name)', 'path');
  blocked('bpy.ops.export_scene.gltf(filepath=LEGION_EXPORT_DIR + "//server/x")', 'path');
  blocked('bpy.ops.export_scene.gltf(filepath=b"/tmp/x")', 'path');
  blocked('bpy.ops.export_scene.gltf(filepath=\n)', 'path');
  blocked('bpy.ops.wm.append(filepath="/etc/x.blend", directory="/etc/x.blend/Object/", filename="Cube")', 'path');
  blocked('bpy.context.scene.render.filepath = "/etc/x"', 'path');
  blocked('bpy.context.scene.render.filepath = p', 'path');
  blocked('img.filepath = "/home/u/secret.png"', 'path');
  blocked('img.filepath_raw = path', 'path');
  blocked('node.base_path = "/etc"', 'path');
  blocked('bpy.data.images.load("/etc/passwd")', 'path');
  blocked('bpy.data.images.load(p)', 'path');
  blocked('bpy.data.images.load(*args)', 'path-unpacking');
  blocked('bpy.data.fonts.load("/usr/share/fonts/x.ttf")', 'path');
  blocked('img.save_render("/tmp/x.png")', 'path');
  blocked('img.save(filepath="/tmp/x.png")', 'path');
  blocked('bpy.ops.import_image.to_plane(files=[{"name": "../../etc/passwd"}], directory="' + DIR + '")', 'path');
  blocked('bpy.ops.import_image.to_plane(files=[{"name": name}], directory="' + DIR + '")', 'path');
  fine('bpy.ops.import_image.to_plane(files=[{"name": "a.png"}], directory="' + DIR + '")');
  blocked('bpy.ops.export_scene.gltf(**opts)', 'keyword-unpacking');
  blocked('bpy.ops.wm.save_as_mainfile(**{"file" + "path": "/etc/x"})', 'keyword-unpacking');
  fine('def f(**kw):\n    return kw\nf = lambda **k: k');
});

test('paths: Windows folders compare case-insensitively and with either slash', () => {
  fine('bpy.ops.export_scene.gltf(filepath="C:/Users/Dan/.legion/ws/sculptor/blender-exports/a.glb")', [WINDIR]);
  fine('bpy.ops.export_scene.gltf(filepath="c:\\\\users\\\\dan\\\\.legion\\\\ws\\\\sculptor\\\\blender-exports\\\\a.glb")', [WINDIR]);
  blocked('bpy.ops.export_scene.gltf(filepath="C:/Users/Dan/Desktop/a.glb")', 'path', [WINDIR]);
  blocked('bpy.ops.export_scene.gltf(filepath="C:/Users/Dan/.legion/ws/sculptor/blender-exports/../../x")', 'path', [WINDIR]);
  assert.equal(pathProblem('/a/b/c', ['/a/b']), null);
  assert.equal(pathProblem('/a/b', ['/a/b']), null);
  assert.ok(pathProblem('/a/bc', ['/a/b']));
  assert.ok(pathProblem('/a/b/../c', ['/a/b']));
  assert.ok(pathProblem('', [])  === null);
});

test('bpy.ops: no aliasing, denied namespaces, wm allowlist, driver operators', () => {
  fine('bpy.ops.object.select_all(action="SELECT")');
  fine('bpy.ops.image.open(filepath="' + DIR + '/a.png")');
  fine('bpy.ops.object.delete()');
  blocked('o = bpy.ops\no.wm.url_open(url="http://x")', 'ops-alias');
  blocked('w = bpy.ops.wm\nw.url_open(url="http://x")', 'ops-alias');
  blocked('getattr(bpy.ops.wm, "url_open")("x")', 'ops-alias');
  blocked('f = bpy.ops.wm.url_open', 'ops-wm');
  blocked('bpy.ops["wm"]', 'ops-alias');
  blocked('(bpy.ops).wm.url_open()', 'ops-alias');
  blocked('bpy.ops.wm.url_open(url="http://example.com")', 'ops-wm');
  blocked('bpy.ops.wm.path_open(filepath="/bin/sh")', 'ops-wm');
  blocked('bpy.ops.wm.context_set_value(data_path="x", value="__import__(1)")', 'ops-wm');
  blocked('bpy.ops.wm.context_set_enum(data_path="scene.x", value="A")', 'ops-wm');
  blocked('bpy.ops.wm.save_userpref()', 'ops-wm');
  blocked('bpy.ops.wm.quit_blender()', 'ops-wm');
  blocked('bpy.ops.wm.read_userpref()', 'ops-wm');
  blocked('bpy.ops.wm.addon_install(filepath="x")', 'ops-wm');
  blocked('bpy.ops.wm.recover_last_session()', 'ops-wm');
  blocked('bpy.ops.wm.open_mainfile(filepath="/etc/x.blend")', 'path');
  blocked('bpy.ops.script.python_file_run(filepath="x.py")', 'ops-namespace');
  blocked('bpy.ops.script.reload()', 'ops-namespace');
  blocked('bpy.ops.text.run_script()', 'ops-namespace');
  blocked('bpy.ops.text.open(filepath="x")', 'ops-namespace');
  blocked('bpy.ops.console.execute()', 'ops-namespace');
  blocked('bpy.ops.preferences.addon_enable(module="x")', 'ops-namespace');
  blocked('bpy.ops.extensions.package_install(repo_index=0, pkg_id="x")', 'ops-namespace');
  blocked('bpy.ops.file.unpack_all()', 'ops-namespace');
  blocked('bpy.ops.image.external_edit(filepath="x")', 'ops-denied');
  blocked('bpy.ops.anim.driver_button_add()', 'ops-driver');
  blocked('bpy.ops.graph.driver_variables_copy()', 'ops-driver');
  blocked('from bpy.ops import wm', 'import');
});

test('wm operators that touch files meet the path rules', () => {
  fine(`bpy.ops.wm.save_as_mainfile(filepath="${DIR}/a.blend", copy=True)`);
  fine(`bpy.ops.wm.obj_export(filepath="${DIR}/a.obj")`);
  blocked('bpy.ops.wm.save_as_mainfile(filepath="/tmp/a.blend")', 'path');
  blocked('bpy.ops.wm.obj_export(filepath="/tmp/a.obj")', 'path');
  blocked('bpy.ops.wm.link(filepath="/x/y.blend", directory="/x/y.blend/Collection/", filename="C")', 'path');
  blocked('bpy.ops.wm.append(directory="/x/y.blend/Object/", filename="C")', 'path');
});

test('notes: allowed but notable things are listed for the approval card', () => {
  const r = check('bpy.ops.wm.read_homefile(use_empty=True)\nbpy.ops.object.delete()\nwhile False:\n    pass\nbpy.ops.wm.save_mainfile()');
  assert.equal(r.ok, true);
  assert.ok(r.notes.some((n) => /replaces the open scene/.test(n)), r.notes.join('|'));
  assert.ok(r.notes.some((n) => /deletes objects/.test(n)));
  assert.ok(r.notes.some((n) => /while loop/.test(n)));
  assert.ok(r.notes.some((n) => /saves the \.blend/.test(n)));
  const w = check(`bpy.ops.export_scene.gltf(filepath="${DIR}/a.glb")`);
  assert.ok(w.notes.some((n) => n.includes(`${DIR}/a.glb`)));
});

test('limits: empty, huge, NUL', () => {
  blocked('   \n', 'empty');
  blocked('x = 1\n'.repeat(Math.ceil(MAX_SCRIPT_BYTES / 6) + 10), 'size');
  assert.equal(check('x = 1').lines, 1);
});

test('findings carry line and snippet; describeFindings is for the agent', () => {
  const r = check('import bpy\nx = 1\nimport os\n');
  assert.equal(r.ok, false);
  assert.equal(r.findings[0]!.line, 3);
  assert.equal(r.findings[0]!.snippet, 'import os');
  const text = describeFindings(r);
  assert.match(text, /not run/);
  assert.match(text, /line 3/);
});

test('scriptHash is sha256 hex and stable', () => {
  assert.match(scriptHash('x'), /^[0-9a-f]{64}$/);
  assert.equal(scriptHash('x'), scriptHash('x'));
  assert.notEqual(scriptHash('x'), scriptHash('y'));
});

test('multiline brackets and continuation do not fool the scanner', () => {
  blocked('import bpy\nx = (\n  1,\n  eval(\n  "2"))', 'banned-name');
  blocked('x = 1 \\\n  + eval("1")', 'banned-name');
  blocked("bpy.ops.export_scene.gltf(\n    export_format='GLB',\n    filepath=\n        '/etc/x.glb',\n)", 'path');
  const r = check('a = 1\nb = (\n 2,\n 3)\nimport os\n');
  assert.equal(r.findings[0]!.line, 5);
});

test('adversarial: keyword names and statement forms', () => {
  fine('bpy.ops.mesh.primitive_cube_add(size=2)\nfoo(open=True)'); // a keyword argument named open is only a name
  blocked('open("x")', 'banned-name');
  blocked('f = open', 'banned-name');
  blocked('with open("/etc/passwd") as f:\n    f.read()', 'banned-name');
  blocked('print(open)', 'banned-name');
  blocked('bpy.data.texts.new("a").write(open("x").read())', 'banned-name');
  blocked('x = io.open("a")', 'banned-name');
  blocked('x = codecs.open("a")', 'banned-name');
  blocked('x = obj.open("a")', 'banned-attribute');
  blocked('x = os . system ( "x" )', 'banned-name');
  blocked('x = (  os\n.system)("x")', 'banned-name');
});

// ---- review fixes B1, B2, S1, S2, S7 and the linear-time nit. Every snippet below is a harmless sample: the test asserts the checker REFUSES it.
import { BIDI_CONTROL, INVISIBLE_CHARS } from '../src/core/blender/static-check.js';
const liveCheck = (src: string) => checkScript(src, { allowedDirs: [DIR], live: true });
const liveBlocked = (src: string, rule: string) => {
  const r = liveCheck(src);
  assert.equal(r.ok, false, `expected blocked in live mode:\n${src}`);
  assert.ok(r.findings.some((f) => f.rule === rule), `expected ${rule}, got ${JSON.stringify(r.findings.map((f) => f.rule))}`);
};
const H = 'import bpy\n';

test('B1: text-block-to-module, type-hint evaluation and use_scripts are refused', () => {
  blocked(`${H}m = bpy.data.texts["a"].as_module()`, 'banned-attribute');
  blocked(`${H}x = obj.use_module`, 'banned-attribute');
  blocked(`${H}f = get_type_hints(Foo)`, 'banned-name');
  blocked(`${H}f = ForwardRef("x")`, 'banned-name');
  blocked(`${H}bpy.ops.wm.open_mainfile(filepath="${DIR}/a.blend", use_scripts=True)`, 'use-scripts');
  blocked(`${H}bpy.ops.wm.open_mainfile(filepath="${DIR}/a.blend", use_scripts=False)`, 'use-scripts');
  blocked(`${H}d = dict(use_scripts=1)`, 'use-scripts');
});

test('B1: typing and bpy_extras are not importable', () => {
  blocked('import typing', 'import');
  blocked('from typing import List', 'import');
  blocked('import bpy_extras', 'import');
  blocked('from bpy_extras import io_utils', 'import');
  assert.equal(ALLOWED_MODULES.has('typing'), false);
  assert.equal(ALLOWED_MODULES.has('bpy_extras'), false);
});

test('B2: setattr/getattr with a path-like name is refused, including a name built at run time', () => {
  blocked(`${H}setattr(img, "filepath", "x")`, 'getattr');
  blocked(`${H}n = "file" + "path"\ngetattr(img, n)`, 'getattr');
  blocked(`${H}getattr(img, "directory")`, 'getattr');
});

test('B2: a path-like attribute is checked in every assignment form (tuple, for, with-as, augmented, chained, annotated)', () => {
  for (const src of [
    'img.filepath, k = "/tmp/a", 1',
    'for img.filepath in ["/tmp/a"]:\n    pass',
    'with open(x) as img.filepath:\n    pass',
    'img.filepath += "/tmp/a"',
    'img.filepath = other = "/tmp/a"',
    'img.filepath: str = "/tmp/a"',
    'k, (img.filepath, j) = 1, ("/tmp/a", 2)',
    'img.filepath = some_function()',
  ]) blocked(H + src, 'path');
  fine(`${H}img.filepath = "${DIR}/ok.png"`);
  fine(`${H}img.use_fake_user = True`);
});

test('B2: more path-like attribute names: cache_directory and the file-output slot .path', () => {
  blocked(`${H}scene.cache_directory = "/tmp/x"`, 'path');
  blocked(`${H}slot.path = "/tmp/x"`, 'path');
  blocked(`${H}node.file_slots[0].path = "/tmp/x"`, 'path');
  blocked(`${H}node.base_path = "/tmp/x"`, 'path');
});

test('B2: operator names are NOT exempt from the banned list: unpack operators and the like are refused', () => {
  blocked(`${H}bpy.ops.file.unpack_all()`, 'ops-namespace');
  blocked(`${H}bpy.ops.file.unpack_item()`, 'ops-namespace');
  blocked(`${H}bpy.ops.image.unpack()`, 'banned-attribute');
  blocked(`${H}bpy.ops.script.python_file_run(filepath="x")`, 'ops-namespace');
});

test('S1: only allowlisted operator namespaces: add-on operators and the named operators are refused', () => {
  blocked(`${H}bpy.ops.blendermcp.start_server()`, 'ops-namespace');
  blocked(`${H}bpy.ops.someaddon.do_thing()`, 'ops-namespace');
  blocked(`${H}bpy.ops.render.play_rendered_anim()`, 'ops-denied');
  blocked(`${H}bpy.ops.wm.read_factory_settings()`, 'ops-denied');
  for (const ok of ['mesh.primitive_cube_add()', 'object.select_all(action="DESELECT")', 'transform.translate(value=(1, 0, 0))', 'curve.primitive_bezier_curve_add()', 'wm.save_mainfile()'])
    fine(`${H}bpy.ops.${ok}`);
});

test('S2: live runs refuse to open, append or link any .blend; sandbox runs (inside the VM) may', () => {
  liveBlocked(`${H}bpy.ops.wm.open_mainfile(filepath="${DIR}/a.blend")`, 'ops-blend-load');
  liveBlocked(`${H}bpy.ops.wm.append(directory="${DIR}/a.blend/Object/", filename="C")`, 'ops-blend-load');
  liveBlocked(`${H}bpy.ops.wm.link(directory="${DIR}/a.blend/Object/", filename="C")`, 'ops-blend-load');
  assert.ok(!rules(`${H}bpy.ops.wm.open_mainfile(filepath="${DIR}/a.blend")`).includes('ops-blend-load'), 'the VM is the sandbox: it is not refused there');
});

test('nit: save_as_mainfile must say copy=True (otherwise it re-points the open file)', () => {
  blocked(`${H}bpy.ops.wm.save_as_mainfile(filepath="${DIR}/a.blend")`, 'ops-save-copy');
  blocked(`${H}bpy.ops.wm.save_as_mainfile(filepath="${DIR}/a.blend", copy=False)`, 'ops-save-copy');
  fine(`${H}bpy.ops.wm.save_as_mainfile(filepath="${DIR}/a.blend", copy=True)`);
  liveBlocked(`${H}bpy.ops.wm.save_as_mainfile(filepath="${DIR}/a.blend")`, 'ops-save-copy');
});

test('nit: // relative paths are refused in live mode (they would resolve against the open .blend), allowed only for the sandbox', () => {
  assert.match(pathProblem('//out.obj', [DIR], true) ?? '', /./);
  assert.equal(pathProblem('//out.obj', [DIR], false), null);
  liveBlocked(`${H}bpy.ops.wm.obj_export(filepath="//out.obj")`, 'path');
  fine(`${H}bpy.ops.wm.obj_export(filepath="${DIR}/o.obj")`);
});

test('S7: bidirectional controls are refused; other invisible characters are noted for the card', () => {
  const bidi = `${H}x = 1‮`;
  blocked(bidi, 'hidden-characters');
  assert.ok(BIDI_CONTROL.test(bidi));
  const inv = check(`${H}x = "a​b"`);
  assert.ok(inv.notes.some((n) => /invisible|hidden|zero-width/i.test(n)), inv.notes.join('|'));
  assert.ok(new RegExp(INVISIBLE_CHARS.source).test('​'));
});

test('S7: a lone \\r is a newline for the checker, so a banned call cannot hide after one', () => {
  const r = check(`${H}x = 1\rimport os`);
  assert.equal(r.ok, false);
  const lines = r.findings.map((f) => f.line);
  assert.ok(lines.includes(3), `the finding is on line 3 (the card splits on lone \\r too), got ${JSON.stringify(lines)}`);
});

test('nit: the checker is linear time: a ~56 KB keyword-heavy script is checked in well under a second', () => {
  const unit = 'bpy.ops.mesh.primitive_cube_add(size=1, location=(0, 0, 0), rotation=(0, 0, 0), enter_editmode=False, align="WORLD")\n';
  const kw = 'obj = foo(' + Array.from({ length: 2000 }, (_, i) => `a${i}=${i}`).join(', ') + ')\n';
  const src = H + unit.repeat(250) + kw;
  assert.ok(src.length > 50_000 && src.length < MAX_SCRIPT_BYTES, String(src.length));
  const t0 = performance.now();
  const r = check(src);
  const ms = performance.now() - t0;
  assert.ok(ms < 1000, `took ${ms.toFixed(0)} ms`);
  assert.ok(r.findings.length >= 0);
  // deeply nested brackets and long chains are linear too
  const nest = `${H}x = ${'('.repeat(2000)}1${')'.repeat(2000)}\n` + `y = ${'[1, '.repeat(3000)}0${']'.repeat(3000)}\n`;
  const t1 = performance.now();
  checkScript(nest, { allowedDirs: [DIR] });
  assert.ok(performance.now() - t1 < 1000);
});
