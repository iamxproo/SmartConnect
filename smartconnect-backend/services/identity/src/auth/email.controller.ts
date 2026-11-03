import { Body, Controller, HttpCode, Inject, Post } from '@nestjs/common';
import { ApiAcceptedResponse, ApiBearerAuth, ApiNoContentResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiProblemResponses, BEARER_AUTH, CurrentPrincipal, Public, type Principal } from '@smartconnect/backend-kit';
import { AcceptedDto, VerifyEmailDto } from './dto.js';
import { EmailVerificationService } from './email-verification.service.js';

@ApiTags('Auth')
@Controller('auth/email')
export class EmailController {
  constructor(@Inject(EmailVerificationService) private readonly verification: EmailVerificationService) {}

  @Public()
  @Post('verify')
  @HttpCode(204)
  @ApiOperation({ summary: 'Verify the email address with the single-use token from the verification email' })
  @ApiNoContentResponse()
  @ApiProblemResponses(400, 422)
  async verify(@Body() dto: VerifyEmailDto): Promise<void> {
    await this.verification.verify(dto.token);
  }

  @Post('verification')
  @HttpCode(202)
  @ApiBearerAuth(BEARER_AUTH)
  @ApiOperation({ summary: "Send a new verification email (only if the caller's address is not verified yet)" })
  @ApiAcceptedResponse({ type: AcceptedDto })
  @ApiProblemResponses(401)
  async resend(@CurrentPrincipal() principal: Principal): Promise<AcceptedDto> {
    await this.verification.resend(principal.userId);
    return { status: 'accepted' };
  }
}
