import { Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';

@Injectable()
export class ReviewsService {
  constructor(private prisma: PrismaService) {}
  forCourse(courseId: number) { return this.prisma.review.findMany({ where: { courseId } }); }
  create(dto: any) { return this.prisma.review.create({ data: dto }); }
  update(id: number, dto: any) { return this.prisma.review.update({ where: { id }, data: dto }); }
  remove(id: number) { return this.prisma.review.delete({ where: { id } }); }
}
