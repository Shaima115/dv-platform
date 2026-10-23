import { Body, Controller, Get, HttpCode, Inject, Param, Post } from '@nestjs/common';
import { CurrentUser, UserEndpoint, ZodValidationPipe, type UserPrincipal } from '@dv/shared';
import type { AddMemberUseCase } from '../../application/use-cases/add-member';
import type { CreateCompanyUseCase } from '../../application/use-cases/create-company';
import type { GetCompanyUseCase } from '../../application/use-cases/get-company';
import type { RequestVerificationUseCase } from '../../application/use-cases/request-verification';
import {
  addMemberSchema,
  createCompanySchema,
  uuidParam,
  type AddMemberDto,
  type CreateCompanyDto,
} from '../dto/schemas';
import { ADD_MEMBER, CREATE_COMPANY, GET_COMPANY, REQUEST_VERIFICATION } from '../tokens';

/** Thin controller: validate input, delegate to a use case. Authorization happens in the use cases. */
@Controller('api/v1/companies')
@UserEndpoint()
export class CompaniesController {
  constructor(
    @Inject(CREATE_COMPANY) private readonly createCompany: CreateCompanyUseCase,
    @Inject(GET_COMPANY) private readonly getCompany: GetCompanyUseCase,
    @Inject(REQUEST_VERIFICATION) private readonly requestVerification: RequestVerificationUseCase,
    @Inject(ADD_MEMBER) private readonly addMember: AddMemberUseCase,
  ) {}

  @Post()
  @HttpCode(201)
  create(
    @CurrentUser() user: UserPrincipal,
    @Body(new ZodValidationPipe(createCompanySchema)) body: CreateCompanyDto,
  ) {
    return this.createCompany.execute(user, body);
  }

  @Get(':id')
  get(
    @CurrentUser() user: UserPrincipal,
    @Param('id', new ZodValidationPipe(uuidParam)) id: string,
  ) {
    return this.getCompany.execute(user, id);
  }

  @Post(':id/verification')
  @HttpCode(202)
  verify(
    @CurrentUser() user: UserPrincipal,
    @Param('id', new ZodValidationPipe(uuidParam)) id: string,
  ) {
    return this.requestVerification.execute(user, id);
  }

  @Post(':id/members')
  @HttpCode(201)
  members(
    @CurrentUser() user: UserPrincipal,
    @Param('id', new ZodValidationPipe(uuidParam)) id: string,
    @Body(new ZodValidationPipe(addMemberSchema)) body: AddMemberDto,
  ) {
    return this.addMember.execute(user, id, body);
  }
}
