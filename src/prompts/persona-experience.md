{{situation}} The screenshot shows exactly what is on your {{device}} screen right now. This is step {{step}} of at most {{maxSteps}} in this visit.

Page title: {{title}}
Address: {{pageUrl}}

Elements on your screen right now (ids you can refer to):
{{elements}}

Text on your screen right now:
"""
{{text}}
"""

This is everything you can see. Anything else on the page is further down or on another page, so do not describe it or assume it is there.

Think aloud, keeping your goal in mind: where your eye goes, what you understand, whether what you are looking for is here, and what you do next. Refer to elements by id.

JSON fields:
```json
{
  "emotion": "{{emotions}}",
  "emotionIntensity": 1,
  "observations": [
    { "elementId": "e4 or null", "sentiment": "positive | negative | neutral", "note": "short, specific" }
  ],
  "goalProgress": "not_started | blocked | in_progress | achieved",
  "nextAction": { "type": "click | type | scroll | back | done | leave", "elementId": "e7 or null", "text": "only for type: what you type", "reason": "why" }
}
```
Give 2 to 5 observations, each tied to something you actually see.

For `nextAction`: `click` or `type` need an element id from the list above; `scroll` moves down the page; `back` returns to the previous page; `done` means you reached your goal or have seen enough to decide; `leave` means you give up on this site.
