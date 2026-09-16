import { HARNESS_FACETS } from '../core/facets.js';
import { ORIGIN_ORDER, type GraphModel, type GraphNode } from './graph-model.js';

/**
 * Plain, dependency-free terminal renderer for `pfl graph` (design doc §27).
 * UTF-8 box-drawing is the default; a locale that is not UTF-8 falls back to
 * ASCII. Nothing is width-truncated — a narrow terminal wraps, which keeps the
 * output lossless.
 */
export interface TreeStyle {
  branch: string;
  last: string;
  pipe: string;
  space: string;
}

const UTF8_STYLE: TreeStyle = { branch: '├─ ', last: '└─ ', pipe: '│  ', space: '   ' };
const ASCII_STYLE: TreeStyle = { branch: '+- ', last: '`- ', pipe: '|  ', space: '   ' };

export function detectTreeStyle(env: NodeJS.ProcessEnv = process.env): TreeStyle {
  const locale = env['LC_ALL'] ?? env['LC_CTYPE'] ?? env['LANG'] ?? '';
  return /utf-?8/i.test(locale) ? UTF8_STYLE : ASCII_STYLE;
}

interface TreeNode {
  label: string;
  children?: TreeNode[];
}

/** Renders the three §27 sections: sources by origin, edges, then effective by facet. */
export function renderGraph(model: GraphModel, style: TreeStyle = UTF8_STYLE): string[] {
  const nodeById = new Map(model.nodes.map((node) => [node.id, node]));
  const lines: string[] = [];

  for (const origin of ORIGIN_ORDER) {
    const nodes = model.nodes.filter((node) => node.origin === origin);
    if (nodes.length === 0) continue;
    lines.push(origin);
    lines.push(
      ...renderTree(
        nodes.map((node) => nodeToTree(node, model, nodeById)),
        style,
      ),
    );
    lines.push('');
  }

  const effective = model.nodes.filter((node) => node.status === 'effective');
  lines.push('effective');
  const groups: TreeNode[] = HARNESS_FACETS.map((facet) => ({
    label: facet,
    children: effective
      .filter((node) => node.facets.includes(facet))
      .map((node) => ({ label: nodeLabel(node) })),
  })).filter((group) => (group.children?.length ?? 0) > 0);
  const unclassified = effective.filter((node) => node.facets.length === 0);
  if (unclassified.length > 0) {
    groups.push({
      label: '(unclassified)',
      children: unclassified.map((node) => ({ label: nodeLabel(node) })),
    });
  }
  lines.push(...(groups.length === 0 ? ['  (none)'] : renderTree(groups, style)));

  return trimTrailingBlank(lines);
}

function nodeToTree(
  node: GraphNode,
  model: GraphModel,
  nodeById: ReadonlyMap<string, GraphNode>,
): TreeNode {
  const label = nodeLabel(node);
  const outgoing = model.edges
    .filter((edge) => edge.from === node.id)
    .map((edge) => {
      const target = nodeById.get(edge.to);
      return {
        label: `${edgeLabel(edge.type)} → ${target === undefined ? edge.to : nodeLabel(target)}`,
      };
    });
  return outgoing.length > 0 ? { label, children: outgoing } : { label };
}

function nodeLabel(node: GraphNode): string {
  return node.inspectability === 'opaque' ? `${node.path} (opaque)` : node.path;
}

function edgeLabel(type: string): string {
  return type === 'accumulates-with' ? 'accumulates' : type;
}

function renderTree(nodes: readonly TreeNode[], style: TreeStyle, prefix = ''): string[] {
  const lines: string[] = [];
  nodes.forEach((node, index) => {
    const isLast = index === nodes.length - 1;
    lines.push(`${prefix}${isLast ? style.last : style.branch}${node.label}`);
    if (node.children !== undefined && node.children.length > 0) {
      lines.push(
        ...renderTree(node.children, style, `${prefix}${isLast ? style.space : style.pipe}`),
      );
    }
  });
  return lines;
}

function trimTrailingBlank(lines: string[]): string[] {
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}
