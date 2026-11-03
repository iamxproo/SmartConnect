import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Put, Query, Req, Res } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiTags,
} from '@nestjs/swagger';
import {
  ApiProblemException,
  ApiProblemResponses,
  BEARER_AUTH,
  CurrentPrincipal,
  type Principal,
} from '@smartconnect/backend-kit';
import type { Request, Response } from 'express';
import { pipeline } from 'node:stream';
import { pageOf } from '../common/pagination.js';
import { UuidParam } from '../common/uuid-param.js';
import { CurrentOrg } from '../org/org-membership.guard.js';
import type { OrgMembership } from '../org/organization-directory.js';
import { INLINE_TYPES } from './content-type.js';
import { CreateFileDto, FileDto, FileListDto, ListFilesQueryDto } from './dto.js';
import { FilesService } from './files.service.js';
import { contentDisposition } from './names.js';

const actorOf = (org: OrgMembership, principal: Principal) => ({
  organizationId: org.organizationId,
  userId: principal.userId,
});

/** Every route is protected: the global AccessTokenGuard authenticates and OrgMembershipGuard checks the path's org. */
@ApiTags('Files')
@ApiBearerAuth(BEARER_AUTH)
@Controller('orgs/:orgId/files')
export class FilesController {
  constructor(@Inject(FilesService) private readonly files: FilesService) {}

  @Post()
  @ApiOperation({ summary: 'Declare an upload (any organization member); send the bytes with PUT …/content' })
  @ApiCreatedResponse({ type: FileDto })
  @ApiProblemResponses(401, 404, 422)
  async create(
    @CurrentOrg() org: OrgMembership,
    @CurrentPrincipal() principal: Principal,
    @Body() dto: CreateFileDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<FileDto> {
    const file = await this.files.create(actorOf(org, principal), dto);
    res.setHeader('Location', `/api/v1/orgs/${org.organizationId}/files/${file.id}`);
    return file;
  }

  @Get()
  @ApiOperation({ summary: "The caller's own uploaded files, newest first; `q` filters by name" })
  @ApiOkResponse({ type: FileListDto })
  @ApiProblemResponses(401, 404, 422)
  list(
    @CurrentOrg() org: OrgMembership,
    @CurrentPrincipal() principal: Principal,
    @Query() query: ListFilesQueryDto,
  ): Promise<FileListDto> {
    return this.files.list(actorOf(org, principal), pageOf(query), query.q);
  }

  @Put(':fileId/content')
  @ApiOperation({ summary: 'Upload the bytes (uploader only, once, while pending_upload). Streamed, never buffered' })
  @ApiConsumes('application/octet-stream')
  @ApiBody({ schema: { type: 'string', format: 'binary' } })
  @ApiOkResponse({ type: FileDto })
  @ApiProblemResponses(401, 404, 409, 413, 415, 422)
  upload(
    @CurrentOrg() org: OrgMembership,
    @CurrentPrincipal() principal: Principal,
    @Param('fileId', UuidParam()) fileId: string,
    @Req() req: Request,
  ): Promise<FileDto> {
    if (!req.is('application/octet-stream'))
      throw new ApiProblemException(
        415,
        'unsupported_media_type',
        'The content must be sent as application/octet-stream.',
      );
    return this.files.upload(actorOf(org, principal), fileId, req);
  }

  @Get(':fileId')
  @ApiOperation({ summary: 'File metadata (uploader, or anyone who can see a message attaching it)' })
  @ApiOkResponse({ type: FileDto })
  @ApiProblemResponses(401, 404, 503)
  get(
    @CurrentOrg() org: OrgMembership,
    @CurrentPrincipal() principal: Principal,
    @Param('fileId', UuidParam()) fileId: string,
    @Req() req: Request,
  ): Promise<FileDto> {
    return this.files.get(actorOf(org, principal), fileId, req);
  }

  @Get(':fileId/content')
  @ApiOperation({ summary: 'Stream the bytes. Inline only for PNG, JPEG, GIF and WebP; a download otherwise' })
  @ApiProduces('application/octet-stream')
  @ApiProblemResponses(401, 404, 503)
  async download(
    @CurrentOrg() org: OrgMembership,
    @CurrentPrincipal() principal: Principal,
    @Param('fileId', UuidParam()) fileId: string,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const { file, stream } = await this.files.download(actorOf(org, principal), fileId, req);
    res.status(200);
    res.setHeader('Content-Type', file.mimeType === 'text/plain' ? 'text/plain; charset=utf-8' : file.mimeType);
    res.setHeader('Content-Length', String(file.sizeBytes));
    res.setHeader(
      'Content-Disposition',
      contentDisposition(INLINE_TYPES.has(file.mimeType) ? 'inline' : 'attachment', file.name),
    );
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.setHeader('Cache-Control', 'private, no-store');
    pipeline(stream, res, () => undefined); // a failure mid-stream destroys the response; the client sees a short body
  }

  @Delete(':fileId')
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete a file (uploader only); the bytes become unreadable' })
  @ApiNoContentResponse()
  @ApiProblemResponses(401, 404)
  async remove(
    @CurrentOrg() org: OrgMembership,
    @CurrentPrincipal() principal: Principal,
    @Param('fileId', UuidParam()) fileId: string,
  ): Promise<void> {
    await this.files.remove(actorOf(org, principal), fileId);
  }
}
