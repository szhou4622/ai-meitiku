import { randomBytes } from "node:crypto";
import { createFreshMachineIdentity, invalidateMachineIdentity } from "./machine-code.mjs";
import { MachineIdentityService } from "./machine-identity/service.mjs";
import { LicenseService } from "./license-service.mjs";

const pending = (journal) => ["prepared", "accepted"].includes(journal?.phase);

// A durable encrypted journal is written before the request and before local
// commit. The candidate identity stays local until the existing activation
// endpoint accepts the new, unused card. The old server binding is untouched.
export class MachineIdentityRepair {
  constructor({ service, platform = process.platform, candidateProvider, factorProvider }) {
    this.service = service;
    this.store = service.secureStore;
    this.platform = platform;
    this.candidateProvider = candidateProvider || (() => createFreshMachineIdentity({
      appName: service.config.appName, platform,
    }));
    this.factorProvider = factorProvider || (async () => {
      const factors = new MachineIdentityService({
        appName: service.config.appName, clientVersion: service.clientVersion,
        platform, secureStore: null,
      });
      await factors.collectFreshForActivation();
      return factors;
    });
    this.inFlight = null;
  }

  state(message, identityRepairPending = false) {
    return this.service.setState({ phase: "needs_activation", authorized: false,
      license: null, message, identityRepairPending });
  }

  async initialize() {
    const journal = await this.store.readIdentityRepair();
    if (journal?.phase === "accepted") await this.commit(journal);
    else if (pending(journal)) return this.state("设备识别修复尚未确认完成，请输入同一张新激活码并点击修复继续。原机器身份已保留。", true);
    return this.service.initialize();
  }

  async activate(code) {
    if (pending(await this.store.readIdentityRepair())) return this.repair(code);
    return this.service.activate(code);
  }

  async refresh() {
    const journal = await this.store.readIdentityRepair();
    if (journal?.phase === "accepted") return this.initialize();
    if (pending(journal)) return this.state("请用同一张新激活码继续修复设备识别，暂不切回旧身份激活。", true);
    return this.service.refresh();
  }

  repair(code) {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.run(String(code ?? "").trim()).catch(async (error) => {
      this.service.diagnostic("error", "identity_repair", "设备识别修复未完成", { errorCode: error?.code || "repair_failed" });
      let isPending = true;
      try { isPending = pending(await this.store.readIdentityRepair()); } catch { /* Unknown must remain blocked. */ }
      return this.state(error?.message || "修复未完成，原数据及修复进度已保留，请重试。", isPending);
    }).finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  async run(code) {
    if (!code || code.length > 512) return this.state("请输入全新、未绑定的月卡或年卡激活码。", pending(await this.store.readIdentityRepair()));
    let journal = await this.store.readIdentityRepair();
    const wasPending = pending(journal);
    if (pending(journal) && journal.activationCode !== code) {
      return this.state("上次修复结果尚未确认，请使用同一张激活码继续，避免重复使用新码。", true);
    }
    if (journal?.phase === "accepted") {
      await this.commit(journal);
      return this.service.initialize();
    }
    // Even partial historical proof is meaningful. Never erase it to make a
    // previously licensed installation look like an unlicensed installation.
    if (await this.store.readCredential()) {
      return { ...this.service.publicState(), message: "检测到本地历史授权凭证，已停止新身份修复。请先重新验证原授权或联系管理员迁移；原数据未改变。" };
    }
    if (await this.store.readOfflineGrant?.()) {
      return this.state("检测到历史离线授权，已停止修复并保留原数据，请联系管理员核对。");
    }
    const candidate = await this.candidateProvider();
    if (candidate.identity_scheme !== "system_uuid_v1" || candidate.hardware_match !== true) throw new Error("未读取到可靠的新设备身份，未提交激活请求。");
    if (pending(journal) && journal.candidate.active_machine_code !== candidate.active_machine_code) {
      throw new Error("当前设备与待完成的修复身份不一致，请回原电脑继续，或联系管理员核对。");
    }
    const factors = await this.factorProvider();
    const payload = factors?.payloadForRequest?.();
    const keys = this.platform === "win32" ? ["machine_guid", "bios_uuid", "system_disk_serial"] : ["io_platform_uuid", "io_platform_serial_number"];
    if (!payload || payload.platform !== this.platform || payload.low_confidence
      || keys.filter((key) => payload.factors?.[key]?.hash).length < 2) {
      throw new Error("本机硬件信息采集不足，未提交修复请求。请稍后重试。");
    }
    if (!pending(journal)) {
      const originalIdentity = await this.store.readMachineIdentity();
      const originalCode = await this.store.readMachineCode();
      if (originalIdentity?.identity_scheme === "system_uuid_v1" || candidate.active_machine_code === originalCode
        || candidate.active_machine_code === originalIdentity?.active_machine_code) {
        return this.state("本机已使用新的设备识别方式，无需再次更换；如仍有冲突，请联系管理员核对。");
      }
      if (!originalIdentity && !originalCode) return this.state("未发现需要修复的旧机器身份，请直接使用立即激活。");
      journal = { version: 1, phase: "prepared", activationCode: code,
        recoverySecret: randomBytes(32).toString("hex"), candidate,
        original: { identity: originalIdentity, machineCode: originalCode },
        createdAt: new Date().toISOString() };
      await this.store.writeIdentityRepair(journal);
    }
    this.service.diagnostic("info", "identity_repair", "已保留旧身份，开始使用新机器码验证新激活码");
    let responseStatus = 0;
    // An isolated service validates the complete response using the existing
    // binding/entitlement checks, and stages credentials only in the journal.
    const staged = new LicenseService({
      config: this.service.config, clientVersion: this.service.clientVersion,
      now: this.service.now, machineIdentity: factors,
      localMachineIdentity: async () => candidate,
      machineCode: async () => candidate.active_machine_code,
      onDiagnostic: this.service.onDiagnostic,
      fetchImpl: async (...args) => {
        const response = await this.service.fetchImpl(...args);
        responseStatus = response.status;
        return response;
      },
      secureStore: {
        readCredential: async () => null,
        readOrCreateActivationRecoverySecret: async () => journal.recoverySecret,
        writeCredential: async (credential) => {
          const boundMachineCode = String(credential.boundMachineCode || "").toLowerCase();
          if (!(boundMachineCode === candidate.active_machine_code || /^v3_[a-f0-9]{64}$/.test(boundMachineCode))
            || !["activated", "already_bound"].includes(credential.action)
            || credential.bindingStatus !== "active" || credential.isDisabled || credential.isExpired) {
            throw new Error("修复服务未返回可恢复的设备凭证，原身份未改变，请联系管理员。");
          }
          const accepted = { ...journal, credential, phase: "accepted" };
          await this.store.writeIdentityRepair(accepted);
          journal = accepted;
        },
      },
    });
    const result = await staged.activate(code, { stageOnly: true });
    if (journal.phase !== "accepted") {
      // Only a definitive rejection allows a different card. A 5xx or network
      // failure could have happened after commit; keep the same recovery secret.
      if (!wasPending && [400, 404, 409, 422].includes(responseStatus)) {
        journal = { ...journal, phase: "rejected" };
        await this.store.writeIdentityRepair(journal);
      }
      return this.state(result.message + (pending(journal) ? " 请保留并使用同一张激活码继续修复。" : ""), pending(journal));
    }
    await this.commit(journal);
    // The ordinary service will collect and bind fresh factors before granting
    // access. No authorization is granted by the repair UI itself.
    return this.service.initialize();
  }

  async commit(journal) {
    const current = await this.candidateProvider();
    if (current.active_machine_code !== journal.candidate.active_machine_code) throw new Error("设备身份已变化，已保留修复进度，请联系管理员核对。");
    const credential = await this.store.readCredential();
    if (credential && (credential.codeId !== journal.credential.codeId
      || credential.deviceCredential !== journal.credential.deviceCredential)) {
      throw new Error("检测到另一份本地授权，已停止写入，请联系管理员核对。");
    }
    // Replaying these idempotent writes repairs a crash between any two files.
    // Keep phase=accepted until every durable write succeeds.
    await this.store.writeMachineIdentity(journal.candidate);
    await this.store.writeMachineCode(journal.candidate.active_machine_code);
    await this.store.writeActivationRecoverySecret(journal.recoverySecret);
    await this.store.writeCredential(journal.credential);
    await this.store.clearMachineIdentityFactors?.();
    // A startup collector can hold the old cached factors in memory.
    const factors = this.service.machineIdentity;
    if (factors) {
      await factors.start?.();
      if (factors.run) {
        factors.result = null;
        await factors.run({ skipCache: true });
      }
    }
    await this.store.writeIdentityRepair({ ...journal, phase: "committed", committedAt: new Date().toISOString() });
    invalidateMachineIdentity(this.store);
    this.service.diagnostic("success", "identity_repair", "设备识别修复已保存，旧身份备份已保留");
  }
}
