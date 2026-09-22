// React normally lives as long as its document. Our bundled copy can retire
// while the native client's React keeps running, so its document-level event
// and private listening marker must belong to the SDK's UI owners.
const documents = new Map();

export function markSelectionDocument(document, marker) {
  const previous = Object.getOwnPropertyDescriptor(document, marker);
  document[marker] = true;
  documents.set(document, { marker, previous, listeners: new Set() });
}

export function addUIEventListener(target, type, listener) {
  target.addEventListener(type, listener, false);
  if (type === 'selectionchange') documents.get(target)?.listeners.add(listener);
}

export function releaseDocumentEvents() {
  const errors = [];
  for (const [document, record] of documents) {
    for (const listener of record.listeners) {
      try { document.removeEventListener('selectionchange', listener, false); }
      catch (error) { errors.push(error); }
    }
    // Allow the same SDK copy to attach a fresh listener when a page reopens.
    // Never clear another React copy's marker, or overwrite a changed value.
    try {
      if (Object.getOwnPropertyDescriptor(document, record.marker)?.value === true) {
        if (record.previous) Object.defineProperty(document, record.marker, record.previous);
        else delete document[record.marker];
      }
    } catch (error) { errors.push(error); }
  }
  documents.clear();
  if (errors.length) throw new AggregateError(errors, 'SDK document event cleanup failed');
}
