The page has loaded. The screenshot shows exactly what is on your {{device}} screen right now, before scrolling.

Page title: {{title}}
Address: {{pageUrl}}

Elements on your screen right now (ids you can refer to):
{{elements}}

Text on your screen right now:
"""
{{text}}
"""

This is everything you can see. Anything else on the page is further down and would require scrolling, so do not describe it or assume it is there.

Think aloud through your first seconds on this page, keeping your goal in mind: where your eye goes first, what you understand, what you are looking for and whether you can find it on this screen, and what you would do next. Refer to elements by id.

JSON fields:
```json
{
  "emotion": "{{emotions}}",
  "emotionIntensity": 1,
  "observations": [
    { "elementId": "e4 or null", "sentiment": "positive | negative | neutral", "note": "short, specific" }
  ],
  "goalProgress": "not_started | blocked | in_progress | achieved",
  "nextAction": { "type": "click | type | scroll | leave", "elementId": "e7 or null", "reason": "why" }
}
```
Give 2 to 5 observations, each tied to something you actually see.
