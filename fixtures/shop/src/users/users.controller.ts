import { Controller, Get, Patch, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Roles } from '../common/guards/roles.guard';
@UseGuards(AuthGuard('jwt'))
@Controller('users')
export class UsersController {
  @Get('me') me() {}
  @Get() @Roles('ADMIN', 'SUPPORT') list() {}
  @Patch(':id/role') @Roles('ADMIN') changeRole() {}
}
