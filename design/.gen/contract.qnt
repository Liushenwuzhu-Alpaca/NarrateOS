// 由 ssot gen 从 contract/*.vdmsl 生成；只读，不要手改。
module Vdm {
  type Opt[a] = | Nil | Some(a)
}
module narrateos_hostService_bookStore {
  type ChapterId = str
  type Confirmation = str
  type Ledger = { manuscripts: Set[ChapterId], confirmations: ChapterId -> Confirmation, settled: Set[ChapterId] }
  pure val initial: Ledger = { manuscripts: Set(), confirmations: Map(), settled: Set() }
  type Call =
    | commitManuscript({ ch: ChapterId, cf: Confirmation })
    | settleDerivedState({ ch: ChapterId, cf: Confirmation })
}
module narrateos_hostService_bookTools {
  import narrateos_hostService_bookStore as narrateos_hostService_bookStore
  type SessionId = str
  type Rejected = | Rejected_Rejected
  type Staging = { sealed: Set[narrateos_hostService_bookStore::ChapterId], staged: SessionId -> narrateos_hostService_bookStore::ChapterId }
  pure val initial: Staging = { sealed: Set(), staged: Map() }
  type StageEdit_Result = | StageEdit_Result_Rejected(Rejected) | StageEdit_Result_SessionId(SessionId)
  type Call =
    | stageEdit({ ch: narrateos_hostService_bookStore::ChapterId, sid: SessionId, result: StageEdit_Result })
    | yieldSession({ ch: narrateos_hostService_bookStore::ChapterId, sid: SessionId })
    | abortSession({ ch: narrateos_hostService_bookStore::ChapterId })
}
module contract {
  import narrateos_hostService_bookStore as narrateos_hostService_bookStore
  import narrateos_hostService_bookTools as narrateos_hostService_bookTools
  type Call =
    | NoCall
    | narrateos_hostService_bookStore(narrateos_hostService_bookStore::Call)
    | narrateos_hostService_bookTools(narrateos_hostService_bookTools::Call)
}
