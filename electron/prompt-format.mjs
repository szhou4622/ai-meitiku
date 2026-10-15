// Only insert whitespace in the timeline section; never invent shot boundaries.
export function formatPromptTimeline(value) {
  const text = String(value ?? "").replace(/([^\n])(?=【(?:主体|风格|时间线|BGM|限制)】)/g, "$1\n\n");
  return text.replace(
    /(【时间线】)([\s\S]*?)(?=【[^】]+】|$)/g,
    (_match, heading, body) => {
      const range = /(?:\d+(?::\d{1,2}){0,2}(?:\.\d+)?)\s*(?:秒|s)?\s*[-–—~～至]\s*(?:\d+(?::\d{1,2}){0,2}(?:\.\d+)?)\s*(?:秒|s)/gi;
      let cursor = 0;
      let output = "";
      for (const match of body.matchAll(range)) {
        output += body.slice(cursor, match.index);
        const line = output.slice(output.lastIndexOf("\n") + 1);
        if (output.trim() && !/\n\s*$/.test(output) && !/^\s*\d+[.、．]\s*$/.test(line)) output += "\n";
        output += match[0];
        cursor = match.index + match[0].length;
      }
      output += body.slice(cursor);
      return heading + (/^\s*\n/.test(output) ? output : "\n" + output);
    },
  );
}
