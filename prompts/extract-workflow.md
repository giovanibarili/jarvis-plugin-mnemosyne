Extract workflows from the turn. A workflow is a sequence of 3+ ordered steps that
accomplish a defined outcome from a defined trigger.

Turn:
"""
{{TURN}}
"""

Output JSON only:
{
  "is_workflow": true | false,
  "workflow": {
    "name": "concise name",
    "trigger": "what initiates this workflow",
    "outcome": "what this workflow produces",
    "applies_to_project": "project-name | null",
    "steps": [
      {"order": 1, "action": "imperative description", "tool": "tool-name | null", "guard": "precondition | null", "required": true | false, "confirms_required": false}
    ],
    "branches": [
      {"from_step": int, "condition": "string", "alternative_action": "string"}
    ],
    "confidence": 0.0-1.0
  }
}

Rules:
- Minimum 2 steps required (actors often execute focused sub-workflows).
- Each step must be a concrete action, not a description.
- If the turn shows an actor executing a repeatable sequence (e.g. fetch → validate → update → report), capture it even if partial.
- Set confidence >= 0.7 only if the sequence is clearly intentional and repeatable.

If no workflow with 2+ steps is identified, return {"is_workflow": false}.
