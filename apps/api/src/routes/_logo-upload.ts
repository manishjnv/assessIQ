// Shared reader for the tenant-logo upload routes: multipart field `file`
// OR JSON { content_base64 }. Mirrors modules/04-question-bank/src/import-routes.ts.
// Size/format/dimension rules live in @assessiq/tenancy validateLogo (called by setTenantLogo).

import type { FastifyRequest } from 'fastify';
import { AppError, ValidationError } from '@assessiq/core';
import { LOGO_MAX_BYTES } from '@assessiq/tenancy';
import { parseBody, z } from './_validate.js';

const logoJsonBody = z.object({ content_base64: z.string().min(1, 'content_base64 is required') });

export async function readLogoUpload(req: FastifyRequest): Promise<Buffer> {
  const tooLarge = () => new AppError('The logo is larger than 512 KB.', 'LOGO_TOO_LARGE', 413);
  let data: Buffer;
  if (req.isMultipart()) {
    try {
      const part = await req.file();
      if (part === undefined) {
        throw new ValidationError('file part is required', { details: { code: 'LOGO_FILE_REQUIRED' } });
      }
      data = await part.toBuffer();
      if (part.file.truncated) throw tooLarge();
    } catch (e) {
      if ((e as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE') throw tooLarge();
      throw e;
    }
  } else {
    data = Buffer.from(parseBody(logoJsonBody, req.body, { code: 'LOGO_FILE_REQUIRED' }).content_base64, 'base64');
  }
  if (data.length > LOGO_MAX_BYTES) throw tooLarge();
  return data;
}
