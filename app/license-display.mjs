const DAY_MS = 24 * 60 * 60 * 1000;

function positiveInteger(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : 0;
}

function totalAuthorizedDays(license) {
  const activatedAt = Date.parse(String(license?.activatedAt || ""));
  const expiresAt = Date.parse(String(license?.expiresAt || ""));
  if (!Number.isFinite(activatedAt) || !Number.isFinite(expiresAt) || expiresAt <= activatedAt) return 0;
  return Math.max(1, Math.round((expiresAt - activatedAt) / DAY_MS));
}

function originalCardType(license) {
  const type = String(license?.licenseType || "").toLowerCase();
  const durationDays = positiveInteger(license?.durationDays);
  if (type.includes("year") || type.includes("annual") || type.includes("年")) return "年卡";
  if (type.includes("month") || type.includes("月")) return "月卡";
  if (durationDays >= 300) return "年卡";
  if (durationDays > 0) return "月卡";
  return "时间授权";
}

export function licenseDisplayDetails(license) {
  if (!license) {
    return { typeLabel: "—", durationTitle: "授权时长", durationLabel: "—", accumulated: false };
  }

  const statedDays = positiveInteger(license.durationDays);
  const authorizedDays = totalAuthorizedDays(license);
  // Allow one day for timestamp rounding and daylight-saving transitions.
  const accumulated = statedDays > 0 && authorizedDays > statedDays + 1;

  if (accumulated) {
    return {
      typeLabel: "时间授权",
      durationTitle: "累计授权时长",
      durationLabel: `${authorizedDays} 天`,
      accumulated: true,
    };
  }

  const displayDays = statedDays || authorizedDays;
  return {
    typeLabel: originalCardType(license),
    durationTitle: "授权时长",
    durationLabel: displayDays > 0 ? `${displayDays} 天` : "—",
    accumulated: false,
  };
}
