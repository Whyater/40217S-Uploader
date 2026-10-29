/**
 * Error type for everything the uploader throws on purpose.
 *
 * `message` is short and meant for a person. `code` is for code paths.
 * `detail` holds the technical reason (NACK name, bytes received, ...).
 */
export class V5Error extends Error {
  constructor(code, message, { detail, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'V5Error';
    this.code = code;
    this.detail = detail;
  }
}

export const MESSAGES = {
  NO_RESPONSE:
    "The brain didn't answer. Check the USB cable is in the brain, not the controller. " +
    'On a computer, pick the port that is not called User.',
  NOT_V5: "Something answered, but it isn't a V5 brain or controller system port.",
  BAD_RESPONSE: 'The brain sent back something unexpected. Unplug the cable, plug it back in, and try again.',
  CONTROLLER_NOT_LINKED:
    "The controller isn't linked to a brain. Turn the brain on and pair it, or plug the cable straight into the brain.",
  CONTROLLER_CHANNEL: "The controller couldn't switch to the download channel. Try again, or plug into the brain.",
  PORT_CLOSED: 'The USB connection closed. Plug the cable back in and try again.',
  CANCELLED: 'Upload cancelled.',
};

/** NACK codes, copied from pros-cli V5Device._rx_ext_packet. */
export const NACKS = {
  0xff: 'General NACK',
  0xce: "CRC error on recv'd packet",
  0xd0: 'Payload too small',
  0xd1: 'Request transfer size too large',
  0xd2: 'Program CRC error',
  0xd3: 'Program file error',
  0xd4: 'Attempted to download/upload uninitialized',
  0xd5: 'Initialization invalid for this function',
  0xd6: 'Data not a multiple of 4 bytes',
  0xd7: 'Packet address does not match expected',
  0xd8: 'Data downloaded does not match initial length',
  0xd9: 'Directory entry does not exist',
  0xda: 'Max user files, no more room for another user program',
  0xdb: 'User file exists',
};

export function v5Error(code, detail, cause) {
  return new V5Error(code, MESSAGES[code] ?? code, { detail, cause });
}

export function nackError(code, command) {
  const reason = NACKS[code] ?? `unknown code 0x${code.toString(16)}`;
  return new V5Error('NACK', `The brain refused the request (${reason}).`, {
    detail: { nack: code, reason, command },
  });
}

/** Errors pros-cli raises as VEXCommError (the ones it catches in a few places). */
export function isCommError(e) {
  return e instanceof V5Error && (e.code === 'NACK' || e.code === 'BAD_RESPONSE');
}
