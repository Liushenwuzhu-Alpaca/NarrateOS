// 担心：单章正文定稿落盘后、派生状态结案前发生 Host Service 崩溃重启或受控暂存门禁拒绝时，
// 某个章节在隔离内存暂存会话尚未清空并关闭暂存窗口前就写下了派生状态结案（REQ-3、REQ-11），
// 或已退出的旧进程工种发出的在途 stageEdit 在该章暂存窗口关闭后到达仍被接纳（REQ-7、REQ-11），
// 或在仍有未完成派生状态结案的半章时未重用随正文保存的终审确认完成恢复结案（REQ-2、REQ-9、REQ-10）。
// 盒子：恢复收束过程 recovering、进程崩溃环境 epoch，契约盒子 narrateos_hostService_bookStore、narrateos_hostService_bookTools；
// 单章两阶段提交与受控暂存交接是一串顺接的步骤（commitChapter → sendStageEdit → answerStageEdit → yieldStage → settleNormal），
// 每一步从输入线取值、调用端口、把凭据放到下一步的输入线上。每个 var 是一条带延迟的线；先后只来自线上的值，不记“走到哪一步”。
module settlement {
  import contract.* from "../.gen/contract"
  import Vdm.* from "../.gen/contract"
  import narrateos_hostService_bookStore as Store from "../.gen/contract"
  import narrateos_hostService_bookTools as Tools from "../.gen/contract"

  pure val CHAPTERS = Set("ch1", "ch2")
  pure val CONFIRMATIONS = Set("cf1", "cf2")
  pure val SESSIONS = Set("s1", "s2", "s3")

  var bookLedger: Store::Ledger
  var toolStaging: Tools::Staging
  // 正在执行未完成章节恢复收束的章节（Host Service 进程内，崩溃时清空）。
  var recovering: Set[Store::ChapterId]
  // Host Service 的第几次运行；崩溃重启让它加一。
  var epoch: int
  // 在途的 stageEdit 暂存编辑请求：带上发出它的进程代次，跨崩溃保留。
  var inflight: Set[(Store::ChapterId, Tools::SessionId, int)]
  // 单章生产与状态结案各步之间的传递线（Host Service 进程内，崩溃时清空）。
  var toStage: Set[Store::ChapterId]
  var awaiting: Set[(Store::ChapterId, Tools::SessionId)]
  var toYield: Set[(Store::ChapterId, Tools::SessionId)]
  var toSettle: Set[Store::ChapterId]
  var lastCall: Call

  pure def dropPair(s: Set[(str, str)], ch: str): Set[(str, str)] = s.filter(p => p._1 != ch)

  def isSettled(ch: Store::ChapterId): bool = ch.in(bookLedger.settled)
  def isRecovering(ch: Store::ChapterId): bool = ch.in(recovering)
  def active(ch: Store::ChapterId): bool = not(isRecovering(ch))
  def allSettled: bool = bookLedger.manuscripts == bookLedger.settled
  // 该章节在当前 Host Service 进程内仍有顺接步骤持有它的推进凭据。
  def heldInProcess(ch: Store::ChapterId): bool =
    ch.in(toStage.union(toSettle)) or
    awaiting.exists(p => p._1 == ch) or toYield.exists(p => p._1 == ch)
  def busySessions: Set[Tools::SessionId] = toolStaging.staged.keys().union(inflight.map(p => p._2))

  // ---------- 契约盒子的反馈线按 VDM post 前进 ----------
  pure def storeAfter(s: Store::Ledger, call: Call): Store::Ledger = match call {
    | narrateos_hostService_bookStore(op) => match op {
        | commitManuscript(a) => {
            ...s,
            manuscripts: s.manuscripts.union(Set(a.ch)),
            confirmations: s.confirmations.put(a.ch, a.cf),
          }
        | settleDerivedState(a) => { ...s, settled: s.settled.union(Set(a.ch)) }
      }
    | _ => s
  }

  pure def toolsAfter(s: Tools::Staging, call: Call): Tools::Staging = match call {
    | narrateos_hostService_bookTools(op) => match op {
        | stageEdit(a) => match a.result {
            | StageEdit_Result_SessionId(sid) => { ...s, staged: s.staged.put(sid, a.ch) }
            | StageEdit_Result_Rejected(_) => s
          }
        | yieldSession(a) => {
            ...s,
            sealed: s.sealed.union(Set(a.ch)),
            staged: s.staged.keys().filter(sid => s.staged.get(sid) != a.ch).mapBy(sid => s.staged.get(sid)),
          }
        | abortSession(a) => {
            ...s,
            sealed: s.sealed.union(Set(a.ch)),
            staged: s.staged.keys().filter(sid => s.staged.get(sid) != a.ch).mapBy(sid => s.staged.get(sid)),
          }
      }
    | _ => s
  }

  action commit(call: Call): bool = all {
    lastCall' = call,
    bookLedger' = storeAfter(bookLedger, call),
    toolStaging' = toolsAfter(toolStaging, call),
  }

  action processWiresUnchanged = all {
    toStage' = toStage, awaiting' = awaiting, toYield' = toYield, toSettle' = toSettle,
  }

  action init = all {
    bookLedger' = Store::initial,
    toolStaging' = Tools::initial,
    recovering' = Set(),
    epoch' = 0,
    inflight' = Set(),
    toStage' = Set(), awaiting' = Set(), toYield' = Set(), toSettle' = Set(),
    lastCall' = NoCall,
  }

  // ---------- 单章两阶段提交与受控暂存：顺接的五步 ----------
  // REQ-2
  // REQ-9
  // REQ-10
  // 阶段一：在无未结案半章时归档定稿正文并同批持久化终审确认，该章进入受控状态抽取暂存的第一条线。
  action commitChapter(ch: Store::ChapterId, cf: Store::Confirmation): bool = all {
    not(ch.in(bookLedger.manuscripts)),
    allSettled,
    recovering == Set(),
    toStage' = toStage.union(Set(ch)),
    awaiting' = awaiting, toYield' = toYield, toSettle' = toSettle,
    recovering' = recovering, epoch' = epoch, inflight' = inflight,
    commit(narrateos_hostService_bookStore(Store::commitManuscript({ ch: ch, cf: cf }))),
  }

  // 发出受控暂存编辑请求：进入在途线，带上发出它的进程代次 epoch。
  action sendStageEdit(ch: Store::ChapterId, sid: Tools::SessionId): bool = all {
    ch.in(toStage),
    active(ch),
    not(sid.in(busySessions)),
    toStage' = toStage.exclude(Set(ch)),
    awaiting' = awaiting.union(Set((ch, sid))),
    inflight' = inflight.union(Set((ch, sid, epoch))),
    toYield' = toYield, toSettle' = toSettle,
    recovering' = recovering, epoch' = epoch,
    commit(NoCall),
  }

  // REQ-7
  // REQ-8
  // REQ-11
  // 在途 stageEdit 到达受控工具边界：章节已记入 sealed 时拒绝；未关闭时也可因触碰保护红线被拒并触发恢复收束。
  action answerStageEdit(ch: Store::ChapterId, sid: Tools::SessionId, e: int, accept: bool): bool = all {
    (ch, sid, e).in(inflight),
    val res = if (ch.in(toolStaging.sealed) or not(accept)) Tools::StageEdit_Result_Rejected(Tools::Rejected_Rejected)
              else Tools::StageEdit_Result_SessionId(sid)
    val waiting = e == epoch and (ch, sid).in(awaiting)
    all {
      inflight' = inflight.exclude(Set((ch, sid, e))),
      awaiting' = if (waiting) awaiting.exclude(Set((ch, sid))) else awaiting,
      toYield' = if (waiting and res == Tools::StageEdit_Result_SessionId(sid)) toYield.union(Set((ch, sid))) else toYield,
      recovering' = if (waiting and res != Tools::StageEdit_Result_SessionId(sid) and not(isSettled(ch)))
                      recovering.union(Set(ch))
                    else recovering,
      toStage' = toStage, toSettle' = toSettle,
      epoch' = epoch,
      commit(narrateos_hostService_bookTools(Tools::stageEdit({ ch: ch, sid: sid, result: res }))),
    }
  }

  // REQ-3
  // REQ-11
  // 终态交接门禁通过：关闭该章当轮暂存窗口并清空暂存会话，交出待结案凭据。
  action yieldStage(ch: Store::ChapterId, sid: Tools::SessionId): bool = all {
    (ch, sid).in(toYield),
    active(ch),
    toYield' = toYield.exclude(Set((ch, sid))),
    toSettle' = toSettle.union(Set(ch)),
    toStage' = toStage, awaiting' = awaiting,
    recovering' = recovering, epoch' = epoch, inflight' = inflight,
    commit(narrateos_hostService_bookTools(Tools::yieldSession({ ch: ch, sid: sid }))),
  }

  // REQ-2
  // REQ-9
  // 阶段二：在暂存窗口已关闭且暂存清空后，重用随正文保存的终审确认写下当轮派生状态结案。
  action settleNormal(ch: Store::ChapterId): bool = all {
    ch.in(toSettle),
    active(ch),
    toSettle' = toSettle.exclude(Set(ch)),
    toStage' = toStage, awaiting' = awaiting, toYield' = toYield,
    recovering' = recovering, epoch' = epoch, inflight' = inflight,
    commit(narrateos_hostService_bookStore(Store::settleDerivedState({
      ch: ch,
      cf: bookLedger.confirmations.get(ch),
    }))),
  }

  // ---------- 崩溃恢复与暂存中止收束过程 ----------
  // REQ-10
  // 崩溃重启后，正文已落盘但尚未完成派生状态结案、且当前进程内无步骤推进的半章，进入恢复收束。
  action detectUnsettled(ch: Store::ChapterId): bool = all {
    ch.in(bookLedger.manuscripts),
    not(isSettled(ch)),
    not(isRecovering(ch)),
    not(heldInProcess(ch)),
    recovering' = recovering.union(Set(ch)),
    epoch' = epoch, inflight' = inflight, processWiresUnchanged,
    commit(NoCall),
  }

  action dropFromProcess(ch: Store::ChapterId): bool = all {
    toStage' = toStage.exclude(Set(ch)),
    awaiting' = dropPair(awaiting, ch),
    toYield' = dropPair(toYield, ch),
    toSettle' = toSettle.exclude(Set(ch)),
  }

  // REQ-11
  // 恢复过程先调用 abortSession 关闭该章当轮暂存窗口并强制清空残留暂存会话。
  action recoverAbortTools(ch: Store::ChapterId): bool = all {
    isRecovering(ch),
    not(isSettled(ch)),
    not(ch.in(toolStaging.sealed)),
    dropFromProcess(ch),
    recovering' = recovering, epoch' = epoch, inflight' = inflight,
    commit(narrateos_hostService_bookTools(Tools::abortSession({ ch: ch }))),
  }

  // REQ-2
  // REQ-9
  // REQ-10
  // 暂存窗口关闭后，恢复过程重用随正文持久化保存的终审确认完成派生状态与节拍伏笔核销。
  action recoverSettle(ch: Store::ChapterId): bool = all {
    isRecovering(ch),
    not(isSettled(ch)),
    ch.in(toolStaging.sealed),
    dropFromProcess(ch),
    recovering' = recovering.exclude(Set(ch)),
    epoch' = epoch, inflight' = inflight,
    commit(narrateos_hostService_bookStore(Store::settleDerivedState({
      ch: ch,
      cf: bookLedger.confirmations.get(ch),
    }))),
  }

  // ---------- 崩溃环境：Host Service 进程退出并重启。进程内传递线与恢复过程消失；持久化存储与在途请求保留 ----------
  action crash = all {
    epoch' = epoch + 1,
    recovering' = Set(),
    toStage' = Set(), awaiting' = Set(), toYield' = Set(), toSettle' = Set(),
    inflight' = inflight,
    commit(NoCall),
  }

  action step = {
    nondet ch = CHAPTERS.oneOf()
    nondet cf = CONFIRMATIONS.oneOf()
    nondet sid = SESSIONS.oneOf()
    nondet accept = Set(true, false).oneOf()
    nondet req = inflight.union(Set(("", "", -1))).oneOf()
    nondet roll = 1.to(8).oneOf()
    any {
      commitChapter(ch, cf),
      sendStageEdit(ch, sid), yieldStage(ch, sid), settleNormal(ch),
      answerStageEdit(req._1, req._2, req._3, accept),
      detectUnsettled(ch), recoverAbortTools(ch), recoverSettle(ch),
      all { roll == 2, epoch < 2, crash },
    }
  }

  // ---------- 性质：写在对外可观察的线上 ----------
  // REQ-3
  // REQ-11
  // 任何已写下派生状态结案的章节，受控工具中没有属于它的未清理暂存会话。
  val noStagedAfterSettled = toolStaging.staged.keys().forall(sid => not(isSettled(toolStaging.staged.get(sid))))
  // REQ-11
  // 任何已写下派生状态结案的章节，它在受控工具中的当轮暂存窗口都已关闭（防止旧会话晚到的 stageEdit 污染）。
  val settledAfterSealed = bookLedger.settled.forall(ch => ch.in(toolStaging.sealed))
  val safety = noStagedAfterSettled and settledAfterSealed

  // ---------- 覆盖目标：证明模型确实走到了关键交错 ----------
  // REQ-3
  // REQ-11
  // 单章顺接走完受控暂存编辑并通过 yieldSession 终态交接门禁，进入待结案线 toSettle。
  val witnessYieldedToSettle = toSettle.size() > 0
  // REQ-2
  // REQ-9
  // REQ-10
  // 全部章节最终完成正文定稿与派生状态两阶段结案。
  val witnessAllChaptersSettled = CHAPTERS.forall(ch => isSettled(ch))
  pure val maxSteps_witnessAllChaptersSettled = 40
  // REQ-7
  // REQ-11
  // 已退出的旧进程发出的 stageEdit 仍在途，而该章节的暂存窗口已经关闭。
  val witnessLateStageAfterSealed = inflight.exists(p => p._3 < epoch and p._1.in(toolStaging.sealed))
  pure val maxSteps_witnessLateStageAfterSealed = 40
  // REQ-10
  // 恢复过程已关闭未完成章节的暂存窗口、尚未写下派生状态结案时进程崩溃。
  val witnessCrashBeforeSettle = CHAPTERS.exists(ch =>
    ch.in(bookLedger.manuscripts) and not(isSettled(ch)) and not(isRecovering(ch)) and
    not(heldInProcess(ch)) and ch.in(toolStaging.sealed))
  pure val maxSteps_witnessCrashBeforeSettle = 40
}
