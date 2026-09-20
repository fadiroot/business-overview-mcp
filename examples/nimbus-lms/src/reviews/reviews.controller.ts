import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Role } from '@prisma/client';
import { Public, Roles, RolesGuard } from '../common/roles.guard';
import { ReviewsService } from './reviews.service';

@Controller('reviews')
@UseGuards(AuthGuard('jwt'), RolesGuard)
export class ReviewsController {
  constructor(private readonly reviews: ReviewsService) {}

  @Public()
  @Get('course/:courseId')
  forCourse(@Param('courseId') courseId: string) { return this.reviews.forCourse(+courseId); }

  @Roles(Role.STUDENT)
  @Post()
  create(@Body() dto: any) { return this.reviews.create(dto); }

  // Any signed-in user can edit a review here, while deleting one needs a moderator.
  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: any) { return this.reviews.update(+id, dto); }

  @Roles(Role.ADMIN, Role.SUPPORT)
  @Delete(':id')
  remove(@Param('id') id: string) { return this.reviews.remove(+id); }
}
