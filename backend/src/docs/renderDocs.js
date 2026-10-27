const METHODS = ['get', 'post', 'patch', 'delete'];

const escape = (value) =>
  String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

const prose = (text) => escape(text ?? '').replace(/`([^`]+)`/g, '<code>$1</code>');

const resolve = (spec, schema) => {
  if (!schema?.$ref) return schema ?? {};
  return resolve(spec, schema.$ref.replace('#/', '').split('/').reduce((node, key) => node[key], spec));
};

const exampleFor = (spec, raw, depth = 0) => {
  const schema = resolve(spec, raw);
  if (depth > 6) return null;
  if (schema.example !== undefined) return schema.example;
  if (schema.const !== undefined) return schema.const;
  if (schema.enum) return schema.enum[0];
  if (schema.default !== undefined) return schema.default;
  if (schema.allOf) return Object.assign({}, ...schema.allOf.map((part) => exampleFor(spec, part, depth + 1)));
  if (schema.oneOf) return exampleFor(spec, schema.oneOf[0], depth + 1);
  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  if (type === 'object' || schema.properties) {
    return Object.fromEntries(Object.entries(schema.properties ?? {}).map(([key, value]) => [key, exampleFor(spec, value, depth + 1)]));
  }
  if (type === 'array') return [exampleFor(spec, schema.items, depth + 1)];
  if (type === 'integer' || type === 'number') return schema.minimum ?? 0;
  if (type === 'boolean') return true;
  if (schema.format === 'date-time') return '2026-10-27T10:00:00.000Z';
  if (schema.format === 'uuid') return '7d9f3c1e-2b4a-4f6e-9c1d-3a5b7e9f1c2d';
  return 'string';
};

const typeOf = (spec, raw) => {
  const schema = resolve(spec, raw);
  if (schema.enum) return schema.enum.join(' | ');
  if (schema.oneOf) return schema.oneOf.map((part) => typeOf(spec, part)).join(' or ');
  const type = Array.isArray(schema.type) ? schema.type.join(' or ') : schema.type ?? 'object';
  const limits = [
    schema.minimum !== undefined && `min ${schema.minimum}`,
    schema.maximum !== undefined && `max ${schema.maximum}`,
    schema.maxLength !== undefined && `max length ${schema.maxLength}`,
    schema.default !== undefined && `default ${schema.default}`,
  ].filter(Boolean);
  return [schema.format ?? type, ...limits].join(', ');
};

const anchor = (method, path) => `${method}-${path.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '')}`;

const operations = (spec) =>
  Object.entries(spec.paths).flatMap(([path, item]) =>
    METHODS.filter((method) => item[method]).map((method) => ({
      path,
      method,
      operation: item[method],
      parameters: [...(item.parameters ?? []), ...(item[method].parameters ?? [])],
    }))
  );

const renderParameters = (spec, parameters) => {
  if (parameters.length === 0) return '';
  const rows = parameters
    .map(
      (p) =>
        `<tr><td><code>${escape(p.name)}</code></td><td>${p.in}</td><td>${escape(typeOf(spec, p.schema))}</td><td>${p.required ? 'yes' : 'no'}</td><td>${prose(p.description)}</td></tr>`
    )
    .join('');
  return `<h4>Parameters</h4><div class="scroll"><table><thead><tr><th>Name</th><th>In</th><th>Type</th><th>Required</th><th>Notes</th></tr></thead><tbody>${rows}</tbody></table></div>`;
};

const renderBody = (spec, body) => {
  if (!body) return '';
  return Object.entries(body.content)
    .map(([type, media]) => {
      const example = media.example ?? (media.schema ? exampleFor(spec, media.schema) : null);
      const fields = resolve(spec, media.schema).properties;
      const table = fields
        ? `<div class="scroll"><table><thead><tr><th>Field</th><th>Type</th><th>Notes</th></tr></thead><tbody>${Object.entries(fields)
            .map(([name, schema]) => {
              const required = resolve(spec, media.schema).required?.includes(name) ? 'Required. ' : '';
              return `<tr><td><code>${escape(name)}</code></td><td>${escape(typeOf(spec, schema))}</td><td>${required}${prose(resolve(spec, schema).description)}</td></tr>`;
            })
            .join('')}</tbody></table></div>`
        : '';
      const sample = type === 'application/json' && example !== null ? `<pre>${escape(JSON.stringify(example, null, 2))}</pre>` : '';
      return `<h4>Request body <span class="muted">${escape(type)}</span></h4>${table}${sample}`;
    })
    .join('');
};

const renderResponses = (spec, responses) => {
  const rows = Object.entries(responses)
    .map(([status, response]) => {
      const media = response.content?.['application/json'];
      const example = media?.schema ? exampleFor(spec, media.schema) : null;
      const detail = example && status < 300 ? `<pre>${escape(JSON.stringify(example, null, 2))}</pre>` : '';
      return `<tr><td><code>${status}</code></td><td>${prose(response.description)}${detail}</td></tr>`;
    })
    .join('');
  return `<h4>Responses</h4><div class="scroll"><table class="responses"><tbody>${rows}</tbody></table></div>`;
};

const STYLE = `
body{margin:0;font:16px/1.55 -apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:#1d1d1d;background:#fff}
main{max-width:860px;margin:0 auto;padding:24px 16px 64px}
h1{font-size:28px;margin:8px 0 4px}h2{font-size:22px;margin:40px 0 8px;padding-bottom:4px;border-bottom:1px solid #ddd}
h3{font-size:17px;margin:28px 0 4px}h4{font-size:14px;margin:16px 0 6px;text-transform:uppercase;letter-spacing:.04em;color:#555}
p{margin:6px 0}a{color:#0645ad}code,pre{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:14px}
code{background:#f3f3f3;padding:1px 4px;border-radius:3px}pre{background:#f7f7f7;border:1px solid #e3e3e3;padding:10px 12px;overflow-x:auto;margin:6px 0}
pre code{background:none;padding:0}table{border-collapse:collapse;width:100%;margin:6px 0;font-size:14px}
th,td{border:1px solid #ddd;padding:6px 8px;text-align:left;vertical-align:top}th{background:#f7f7f7;font-weight:600}
.responses td:first-child{width:56px}.method{font-family:ui-monospace,Menlo,Consolas,monospace;font-weight:700;margin-right:6px}
.muted{color:#666;font-weight:400;text-transform:none;letter-spacing:0}.toc{columns:2;padding-left:18px}.toc li{break-inside:avoid}
.auth{font-size:14px;color:#555}.scroll{overflow-x:auto}td:first-child{white-space:nowrap}
@media (max-width:640px){.toc{columns:1;padding-left:16px}.toc ul{padding-left:16px}main{padding:16px 16px 48px}}
`;

export const renderDocs = (spec, { baseUrl }) => {
  const ops = operations(spec);
  const byTag = spec.tags.map((tag) => ({ tag, ops: ops.filter((op) => op.operation.tags?.[0] === tag.name) }));

  const toc = byTag
    .map(({ tag, ops: list }) => `<li><a href="#tag-${tag.name}">${escape(tag.name)}</a><ul>${list
      .map((op) => `<li><a href="#${anchor(op.method, op.path)}"><span class="method">${op.method.toUpperCase()}</span>${escape(op.path)}</a></li>`)
      .join('')}</ul></li>`)
    .join('');

  const sections = byTag
    .map(({ tag, ops: list }) => {
      const items = list
        .map(({ path, method, operation, parameters }) => `
<h3 id="${anchor(method, path)}"><span class="method">${method.toUpperCase()}</span><code>${escape(path)}</code></h3>
<p><strong>${prose(operation.summary)}</strong></p>
${operation.description ? `<p>${prose(operation.description)}</p>` : ''}
<p class="auth">${operation.security ? 'Needs an API key.' : 'No API key needed.'}</p>
${renderParameters(spec, parameters)}
${renderBody(spec, operation.requestBody)}
${renderResponses(spec, operation.responses)}`)
        .join('');
      return `<h2 id="tag-${tag.name}">${escape(tag.name)}</h2><p>${prose(tag.description)}</p>${items}`;
    })
    .join('');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escape(spec.info.title)}</title><style>${STYLE}</style></head>
<body><main>
<h1>${escape(spec.info.title)}</h1>
<p class="muted">Version ${escape(spec.info.version)} &middot; Base URL <code>${escape(baseUrl)}</code> &middot; <a href="/openapi.json">OpenAPI JSON</a></p>
<p>${prose(spec.info.description)}</p>
<h4>Quick start</h4>
<pre>curl -X POST ${escape(baseUrl)}/api/v1/keys \\
  -H "Content-Type: application/json" -d '{"name":"my app"}'

curl -X POST ${escape(baseUrl)}/api/v1/links \\
  -H "Authorization: Bearer kt_..." -H "Content-Type: application/json" \\
  -d '{"url":"https://example.com/a/long/path"}'</pre>
<h4>Contents</h4>
<ul class="toc">${toc}</ul>
${sections}
</main></body></html>`;
};

export const listOperations = operations;
