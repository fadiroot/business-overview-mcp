import { Controller, Get, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Role } from '@prisma/client';
import { Roles, RolesGuard } from '../common/roles.guard';
import { ReportsService } from './reports.service';

@Controller('admin/reports')
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles(Role.ADMIN)
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get('revenue')
  revenue() { return this.reports.revenue(); }

  @Get('enrollments')
  enrollments() { return this.reports.enrollments(); }

  @Get('instructors')
  instructors() { return this.reports.instructorPayouts(); }
}
