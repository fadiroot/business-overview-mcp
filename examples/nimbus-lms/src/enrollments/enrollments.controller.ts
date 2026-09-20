import { Body, Controller, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Role } from '@prisma/client';
import { Roles, RolesGuard } from '../common/roles.guard';
import { EnrollmentsService } from './enrollments.service';

@Controller('enrollments')
@UseGuards(AuthGuard('jwt'), RolesGuard)
export class EnrollmentsController {
  constructor(private readonly enrollments: EnrollmentsService) {}

  @Get('mine')
  mine() { return this.enrollments.forCurrentStudent(); }

  @Roles(Role.STUDENT)
  @Post()
  enrol(@Body() dto: any) { return this.enrollments.enrol(dto); }

  @Roles(Role.ADMIN, Role.SUPPORT)
  @Get()
  list() { return this.enrollments.list(); }

  @Roles(Role.ADMIN, Role.SUPPORT)
  @Patch(':id/refund')
  refund(@Param('id') id: string) { return this.enrollments.refund(+id); }

  @Roles(Role.INSTRUCTOR, Role.ADMIN)
  @Get('course/:courseId')
  byCourse(@Param('courseId') courseId: string) { return this.enrollments.byCourse(+courseId); }
}
