import env from '../config/env.js';
import { createCodec } from '../utils/codec.js';

export default createCodec(env.codeSecret);