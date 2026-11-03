import { Body, Controller, HttpCode, Inject, Post } from '@nestjs/common';
import { ApiAcceptedResponse, ApiBearerAuth, ApiNoContentResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiProblemResponses, BEARER_AUTH, CurrentPrincipal, Public, type Principal } from '@smartconnect/backend-kit';
import { AcceptedDto, ChangePasswordDto, ForgotPasswordDto, ResetPasswordDto } from './dto.js';
import { PasswordService } from './password.service.js';

@ApiTags('Password')
@Controller('auth/password')
export class PasswordController {
  constructor(@Inject(PasswordService) private readonly passwords: PasswordService) {}

  @Public()
  @Post('forgot')
  @HttpCode(202)
  @ApiOperation({ summary: 'Request a reset email. Same 202 whether or not the account exists' })
  @ApiAcceptedResponse({ type: AcceptedDto })
  @ApiProblemResponses(422)
  async forgot(@Body() dto: ForgotPasswordDto): Promise<AcceptedDto> {
    await this.passwords.requestReset(dto.email);
    return { status: 'accepted' };
  }

  @Public()
  @Post('reset')
  @HttpCode(204)
  @ApiOperation({ summary: 'Set a new password with a single-use reset token; ends every session' })
  @ApiNoContentResponse()
  @ApiProblemResponses(400, 422)
  async reset(@Body() dto: ResetPasswordDto): Promise<void> {
    await this.passwords.reset(dto.token, dto.newPassword);
  }

  @Post('change')
  @HttpCode(204)
  @ApiBearerAuth(BEARER_AUTH)
  @ApiOperation({ summary: 'Change the password (current password required); ends every other session' })
  @ApiNoContentResponse()
  @ApiProblemResponses(401, 403, 422)
  async change(@CurrentPrincipal() principal: Principal, @Body() dto: ChangePasswordDto): Promise<void> {
    await this.passwords.change(principal, dto.currentPassword, dto.newPassword);
  }
}
