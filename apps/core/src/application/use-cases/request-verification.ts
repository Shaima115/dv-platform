import type { Logger, TransactionRunner, UserPrincipal } from '@dv/shared';
import { CoreAction } from '../../domain/authorization/policy';
import { CompanyNotFoundError } from '../../domain/company/company-errors';
import { ensureAllowed, userActor } from '../actor';
import { toCompanyView, type CompanyView } from '../company-view';
import type {
  CompanyRepository,
  MembershipRepository,
  UserAccountRepository,
} from '../ports/repositories';
import type { Clock, CoreSettings, IdGenerator } from '../ports/runtime';
import {
  VerificationUnavailableError,
  type VerificationGateway,
} from '../ports/verification-gateway';

/**
 * Three short steps, and no transaction is open while the HTTP call runs:
 *  1. tx: lock the company, authorize (owner/representative), check it is draft, and claim the
 *     submission with a stable idempotency key. Status stays draft.
 *  2. call verification through Nginx (timeout, bounded retries, same key, circuit breaker).
 *  3a. success → tx: draft → pending with the verification id.
 *  3b. failure → tx: release the claim; company stays draft; caller gets 503.
 * If verification created the request but its response was lost, the retry reuses the key and gets
 * the original request back; if its decision event arrives first, core confirms the submission then.
 */
export class RequestVerificationUseCase {
  constructor(
    private readonly transactions: TransactionRunner,
    private readonly accounts: UserAccountRepository,
    private readonly companies: CompanyRepository,
    private readonly memberships: MembershipRepository,
    private readonly gateway: VerificationGateway,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly settings: CoreSettings,
    private readonly logger: Logger,
  ) {}

  async execute(principal: UserPrincipal, companyId: string): Promise<CompanyView> {
    const claim = await this.transactions.run(async (tx) => {
      const account = await this.accounts.ensure(tx, principal.subject);
      const company = await this.companies.findForUpdate(tx, companyId);
      if (!company) throw new CompanyNotFoundError();
      const role = await this.memberships.roleOf(tx, companyId, account.id);
      if (role === null) throw new CompanyNotFoundError();
      ensureAllowed(CoreAction.REQUEST_VERIFICATION, userActor(principal, account), role);

      const key = company.claimSubmission(
        this.clock.now(),
        this.settings.submissionClaimMs,
        () => `vr-${this.ids.next()}`,
      );
      await this.companies.save(tx, company);
      return { key, role };
    });

    let verificationId: string;
    try {
      ({ verificationId } = await this.gateway.submit(
        { companyId, requestedBySubject: principal.subject },
        claim.key,
      ));
    } catch (error) {
      await this.release(companyId, claim.key);
      throw error;
    }

    return this.transactions.run(async (tx) => {
      const company = await this.companies.findForUpdate(tx, companyId);
      if (!company) throw new CompanyNotFoundError();
      company.markSubmitted(verificationId, this.clock.now());
      await this.companies.save(tx, company);
      this.logger.info(
        {
          operation: 'request_verification',
          company_id: companyId,
          verification_id: verificationId,
        },
        'company moved to pending',
      );
      return toCompanyView(company, claim.role);
    });
  }

  private async release(companyId: string, key: string): Promise<void> {
    try {
      await this.transactions.run(async (tx) => {
        const company = await this.companies.findForUpdate(tx, companyId);
        if (company && company.status === 'draft' && company.submissionKey === key) {
          company.releaseSubmission(this.clock.now());
          await this.companies.save(tx, company);
        }
      });
    } catch (error) {
      // The claim expires on its own; the original failure is what the caller must see.
      this.logger.warn(
        {
          operation: 'request_verification',
          company_id: companyId,
          error_message: (error as Error).message,
        },
        'could not release submission claim',
      );
    }
  }
}

export { VerificationUnavailableError };
