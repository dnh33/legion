#!/usr/bin/env python3
"""
Ask Jev (TypeSafe's System One model) for the editing snap judgments, and write them where the
renderer and the score pick them up.

    TYPESAFE_API_KEY=... python3 docs/video/edit_judge.py      -> docs/video/edit-decisions.json
    node docs/video/render.mjs                                  -> re-renders with Jev's transitions

What Jev decides (one request, all questions in parallel):
  - for every scene change in timeline.mjs CUTS: hard cut, dissolve, or match move
  - which musical palette fits the app (reported, for the record; score.py is written for it)
What stays in code (Jev is not asked to count or do arithmetic):
  - the 96 BPM grid, cut times, reading-time minimums, loudness targets
A Jev answer replaces the default transition only when its confidence clears ACT_CONFIDENCE;
otherwise the principle-based default in timeline.mjs stays and the reason is logged.
Without TYPESAFE_API_KEY the script exits without touching anything (defaults apply).
"""
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'edit-decisions.json')
ACT_CONFIDENCE = 0.6          # below this, keep the default transition (a wrong cut is cheap but visible)
MODEL = 'jev-1.13.0'          # pinned: the threshold above was chosen against this version

TRANSITIONS = {
    'hard': {'what': 'Instant cut on a musical downbeat',
             'for': 'Jumping between two UI screenshots, or a punch into a climax; energy rises',
             'not_for': 'Changing location or mood, or when the same character must visibly travel'},
    'dissolve': {'what': 'Half-second cross-dissolve; both shots overlap, never fading through black',
                 'for': 'Changing scene, location or topic while keeping a calm, solemn flow',
                 'not_for': 'Rapid-fire UI montage, or the moment of the climax'},
    'match': {'what': 'The main character stays on screen and moves to its new position while the rest changes',
              'for': 'When the same character is in both shots and only its framing changes',
              'not_for': 'When the character is absent from either shot'},
}
PALETTES = {
    'gothic_organ_and_phosphor_synth': 'Pipe organ, choir and bells with a pulsing analog synth arpeggio and glitch hits',
    'epic_orchestral_trailer': 'Strings, brass braams, taiko and choir, the standard film-trailer sound',
    'pure_synthwave': 'Analog synths, drum machines, no acoustic or sacred instruments',
    'ambient_drone': 'Slow evolving pads and textures with no beat',
    'none_of_these': None,
}

def cuts_from_timeline():
    js = "import('./timeline.mjs').then(m => console.log(JSON.stringify({cuts: m.CUTS, bpm: m.BPM})))"
    r = subprocess.run(['node', '--input-type=module', '-e', js], cwd=HERE, capture_output=True, text=True, check=True)
    return json.loads(r.stdout)

def main():
    if not os.environ.get('TYPESAFE_API_KEY'):
        print('TYPESAFE_API_KEY is not set; keeping the default transitions in timeline.mjs.')
        return 0
    try:
        from typesafe_sdk import TypeSafeClient, Choice
    except ImportError:
        print('pip install typesafe-sdk first'); return 1

    tl = cuts_from_timeline()
    state = {
        'app': {'name': 'Legion', 'theme': 'Grimdark gothic cathedral (candles, banners, a floating crusader helm called the Relic) '
                                             'fused with a hacker look (phosphor-green terminal text, code on the visor)'},
        'trailer': {'length_seconds': 57.5, 'tempo_bpm': tl['bpm'], 'tone': 'solemn and premium, building to one climax'},
        'cuts': [{'from_shot': c['from'], 'to_shot': c['to']} for c in tl['cuts']],
    }
    questions = {}
    for i, c in enumerate(tl['cuts']):
        questions[c['id']] = Choice(
            instructions=f'Which transition should join `cuts[{i}].from_shot` to `cuts[{i}].to_shot` in this trailer?',
            criteria=TRANSITIONS)
    questions['palette'] = Choice(instructions='Which musical palette best fits `app.theme` for this trailer?', criteria=PALETTES)

    with TypeSafeClient() as client:
        r = client.system_one(state=state, questions=questions, model=MODEL)

    decisions, log = {}, []
    for c in tl['cuts']:
        a = r.choices[c['id']]
        use = a.confidence >= ACT_CONFIDENCE
        if use:
            decisions[c['id']] = a.choice
        log.append({'id': c['id'], 'default': c['kind'], 'jev': a.choice, 'confidence': a.confidence, 'applied': use})
    pal = r.choices['palette']
    json.dump({'model': r.model, 'cuts': decisions, 'log': log,
               'palette': {'choice': pal.choice, 'confidence': pal.confidence},
               'input_tokens': r.usage.input_tokens}, open(OUT, 'w'), indent=2)
    for row in log:
        flag = 'applied' if row['applied'] else 'kept default'
        print(f"{row['id']:15s} default={row['default']:8s} jev={row['jev']:8s} conf={row['confidence']:.2f}  {flag}")
    print('palette:', pal.choice, pal.confidence, '| model', r.model, '| wrote', OUT)
    return 0

if __name__ == '__main__':
    sys.exit(main())
