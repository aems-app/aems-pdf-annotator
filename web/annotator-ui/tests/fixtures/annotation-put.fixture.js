// Ownership branch of AEMS Annotator.update_annotation (core.py:1404-1482).
// Geometry passed here is in the same coordinate space as the stored annotation.
export function applyAnnotationPut(stored, body) {
  const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
  const points = (value) => value?.map((point) => point.map((n) => Number(Number(n).toFixed(3))));
  const changed = (
    (body.content != null && body.content.trim() !== (stored.content || '').trim())
    || (body.color != null && stored.color != null && body.color.toLowerCase() !== stored.color.toLowerCase())
    || (body.rect != null && stored.rect != null && !same(body.rect, stored.rect))
    || (body.page_index != null && body.page_index !== stored.page_index)
    || (body.points != null && !same(points(body.points), points(stored.points)))
    // The real implementation treats supplied quads/anchor_text as a change.
    || body.quads != null || body.anchor_text != null
  );
  const oldSource = stored.source || 'AI';
  const source = body.source ?? (oldSource === 'AI' && changed ? 'HUMAN' : oldSource);
  return {
    ...stored, ...body, source,
    ...(oldSource === 'AI' && source === 'HUMAN'
      ? { original_source: stored.original_source || 'AI' } : {}),
  };
}
