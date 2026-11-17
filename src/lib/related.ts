import { Types } from "mongoose";
import { NotFoundError } from "./errors";
import { scopeFilter, type WorkspaceContext } from "./permissions";
import { Company, Contact } from "../models/Contact";
import { Deal } from "../models/Deal";
import { Lead } from "../models/Lead";
import type { EntityType } from "../models/Task";

export interface ResolvedEntity {
  entityType: EntityType;
  entityId: Types.ObjectId;
  name: string;
  links: Array<{ entityType: EntityType; entityId: Types.ObjectId }>;
}

/**
 * Loads an entity within the caller's tenant and visibility scope, returning a
 * display name and the set of timeline links it should propagate to.
 */
export async function resolveEntity(ctx: WorkspaceContext, entityType: EntityType, id: string): Promise<ResolvedEntity> {
  const base = { _id: new Types.ObjectId(id), ...scopeFilter(ctx) };
  const entityId = base._id;
  switch (entityType) {
    case "lead": {
      const l = await Lead.findOne(base).select("firstName lastName convertedContactId convertedCompanyId convertedDealId").lean();
      if (!l) throw new NotFoundError("Lead");
      const links: ResolvedEntity["links"] = [{ entityType, entityId }];
      if (l.convertedContactId) links.push({ entityType: "contact", entityId: l.convertedContactId });
      if (l.convertedCompanyId) links.push({ entityType: "company", entityId: l.convertedCompanyId });
      return { entityType, entityId, name: `${l.firstName} ${l.lastName ?? ""}`.trim(), links };
    }
    case "contact": {
      const c = await Contact.findOne(base).select("firstName lastName companyId").lean();
      if (!c) throw new NotFoundError("Contact");
      const links: ResolvedEntity["links"] = [{ entityType, entityId }];
      if (c.companyId) links.push({ entityType: "company", entityId: c.companyId });
      return { entityType, entityId, name: `${c.firstName} ${c.lastName ?? ""}`.trim(), links };
    }
    case "company": {
      const c = await Company.findOne(base).select("name").lean();
      if (!c) throw new NotFoundError("Company");
      return { entityType, entityId, name: c.name, links: [{ entityType, entityId }] };
    }
    case "deal": {
      const d = await Deal.findOne(base).select("title companyId contactId").lean();
      if (!d) throw new NotFoundError("Deal");
      const links: ResolvedEntity["links"] = [{ entityType, entityId }];
      if (d.companyId) links.push({ entityType: "company", entityId: d.companyId });
      if (d.contactId) links.push({ entityType: "contact", entityId: d.contactId });
      return { entityType, entityId, name: d.title, links };
    }
  }
}
