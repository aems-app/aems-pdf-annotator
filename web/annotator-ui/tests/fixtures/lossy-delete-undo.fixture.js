export const DELETE_UNDO_PAGE_HEIGHT = 792;

export const LOSSY_DELETE_HIGHLIGHT = {
  id: 'Q1-05',
  stable_id: 'Q1-05',
  requestIdentifier: 'Q1-05',
  check_id: 'Q1-05',
  task_id: 'Q1',
  xref: 105,
  page_index: 0,
  content: 'Quote does not match the image.',
  type: 'Highlight',
  rect: [84.96, 116.74, 527.04, 157.59],
  quads: [
    [84.96, 116.74, 527.04, 128.69],
    [84.96, 131.19, 527.04, 143.14],
    [84.96, 145.63, 145.58, 157.59],
  ],
  anchor_text: 'A three-line anchored quote whose short final line reads "what surface".',
  color: 'amber',
  priority: 'amber',
  source: 'AI',
};

export function cloneLossyDeleteHighlight() {
  return {
    ...LOSSY_DELETE_HIGHLIGHT,
    rect: [...LOSSY_DELETE_HIGHLIGHT.rect],
    quads: LOSSY_DELETE_HIGHLIGHT.quads.map((quad) => [...quad]),
  };
}
