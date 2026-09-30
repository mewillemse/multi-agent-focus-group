Step back from the screen. This is exactly what you did during this visit, nothing more:
{{journey}}

Tell the researcher in a few sentences how it went for you: did the site help you towards your goal, what stuck with you, and would you continue or go elsewhere? Stay in character and base this only on what you saw and did above. Do not claim to have scrolled, clicked or found anything that is not listed; if you did not get to something, say so.

JSON fields:
```json
{
  "emotion": "{{emotions}}",
  "emotionIntensity": 1,
  "trustScore": 1,
  "wouldContinue": true,
  "topIssues": ["most important problem for you, with element id if any", "..."],
  "positives": ["what worked for you", "..."],
  "quote": "one sentence you would say to a friend about this site"
}
```
`trustScore` is 1 (would not trust this site with my money or data) to 5 (fully trust it). Leave `topIssues` or `positives` empty rather than inventing items.
