Extract mental-models expressed in the turn below. A mental-model is how the user
reasons about a domain — analogies, framings, principles, or invariants they rely on.

Turn:
"""
{{TURN}}
"""

Output JSON only:
{
  "candidates": [
    {
      "category": "mental-model",
      "title": "string ~6 words",
      "content": "1-3 sentences capturing the model, the domain it applies to, and the framing",
      "tags": ["tag1", "tag2"],
      "project": "project-name | null",
      "confidence": 0.0-1.0,
      "evidence": "verbatim quote from turn",
      "visibility": "open"
    }
  ]
}

Language rule: detect the language of the user's message in the turn. Apply to title, content, AND tags.
- If the user wrote in English: write title and content in English only.
- If the user wrote in another language (e.g. Portuguese): write the title and content TWICE — first in the original language, then in English — separated by " \ ". Example: "O usuário gosta de morangos vermelhos. \ The user likes red strawberries."
Tags: if not English, include both the native-language tag and its English translation (e.g. ["abacate", "avocado", "fruta", "fruit"]). This ensures retrieval works regardless of query language.

If no mental-model is clearly expressed, return {"candidates": []}.
