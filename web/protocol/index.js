/**
 * V5 PROS uploader protocol, browser-native ES module (no build step).
 * Port contract: an opened Web Serial SerialPort shape,
 *   { readable: ReadableStream<Uint8Array>, writable: WritableStream<Uint8Array> }.
 */
export { uploadProgram, queryBrain, writeFile, uploadLibrary, ensureLibrarySpace, withDownloadChannel } from './upload.js';
export { V5Device, crc32 } from './device.js';
export { SerialConnection } from './connection.js';
export { V5Error, MESSAGES, NACKS } from './errors.js';
export { CRC, VEX_CRC16, VEX_CRC32, gzipCrc32 } from './crc.js';
export { md5 } from './md5.js';
export {
  VID, CHANNEL, FT_COMPLETE, PRODUCT, buildExtPacket, formSimplePacket, formExtendedPayload, parseExtResponse,
  ftInitializePayload, ftWritePayload, ftCompletePayload, vidOptionsNamePayload, transferChannelPayload,
} from './framing.js';
export {
  PROS_ICONS, DEFAULT_COLD_ADDR, DEFAULT_HOT_ADDR, DEFAULT_DESCRIPTION, DEFAULT_IDE_VERSION, generateIni, coldHashName, prosGzip,
  pythonIsoformat, vexTimestamp, versionMatches, programRemoteName,
} from './program.js';
