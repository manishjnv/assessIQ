export const ERASED_CANDIDATE_LABEL = "Erased candidate";

export interface CandidateIdentityRow {
  id: string;
  name: string | null;
  email: string | null;
  erased_at: string | Date | null;
}

export interface CandidateDisplay {
  id: string;
  name: string;        // "Erased candidate" when erased
  email: string | null;  // null when erased
  isErased: boolean;
}

export function displayCandidate(row: CandidateIdentityRow): CandidateDisplay {
  if (row.erased_at) {
    return {
      id: row.id,
      name: ERASED_CANDIDATE_LABEL,
      email: null,
      isErased: true,
    };
  }
  return {
    id: row.id,
    name: row.name ?? row.email ?? "Unknown",
    email: row.email,
    isErased: false,
  };
}
