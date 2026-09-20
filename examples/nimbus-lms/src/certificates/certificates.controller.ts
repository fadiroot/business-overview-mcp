import { Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Role } from '@prisma/client';
import { Public, Roles, RolesGuard } from '../common/roles.guard';
import { CertificatesService } from './certificates.service';

@Controller('certificates')
@UseGuards(AuthGuard('jwt'), RolesGuard)
export class CertificatesController {
  constructor(private readonly certificates: CertificatesService) {}

  @Get('mine')
  mine() { return this.certificates.mine(); }

  @Public()
  @Get('verify/:serial')
  verify(@Param('serial') serial: string) { return this.certificates.verify(serial); }

  @Roles(Role.ADMIN)
  @Post(':enrollmentId/issue')
  issue(@Param('enrollmentId') enrollmentId: string) { return this.certificates.issue(+enrollmentId); }
}
