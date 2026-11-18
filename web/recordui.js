// The enable/disable rules and the results line for the Robot Tests buttons. No DOM, so Node can test it.
export const NO_RESULTS = 'No results yet';
export const RECORD_HELP = 'Record results from the Scourge Tester, then send them. Plug USB into the controller, or the brain as a backup.';

// One USB port: uploads and recording take turns. Send waits for a finished, unsent file.
export function recordRules({ uploading = false, downloading = false, recording = false, stopping = false, supported = true, testerOk = true, hasBuild = true, canSend = false }) {
  const busy = uploading || downloading;
  return {
    recordLabel: recording ? 'Stop Recording' : 'Record Results',
    record: stopping || (!recording && (busy || !supported)),
    send: busy || recording || !canSend,
    upload: busy || recording || !supported || !hasBuild,
    tester: busy || recording || !supported || !testerOk,
  };
}

// recorder statuses use working/success/info/error; the page's status line uses work/good/idle/bad.
const KINDS = { working: 'work', success: 'good', info: 'idle', error: 'bad' };
export const lineKind = (kind) => KINDS[kind] || 'idle';

// Before any status this session, the line shows what the saved file holds.
export function idleLine(file) {
  return file ? file.tally.closed().summary : NO_RESULTS;
}
