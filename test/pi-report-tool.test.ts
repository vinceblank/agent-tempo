/**
 * Unit tests for the Pi-native `report` tool (src/pi/report-tool.ts).
 *
 * Two things proven without Temporal or Pi installed:
 *   1. The TypeBox schema constructs (typebox is a real dependency).
 *   2. The handler routes EXCLUSIVELY through `submitOutbox` — outbox
 *      compliance. The fake submitter is structurally the handler's ONLY
 *      collaborator, so there is no path to a direct peer `.signal()`.
 */
import { expect } from 'chai';
import {
  buildReportSchema,
  buildReportToolDefinition,
  createReportHandler,
  REPORT_TYPES,
  type OutboxSubmitter,
} from '../src/pi/report-tool';
import type { OutboxEntryInput } from '../src/types';

/** Records every outbox submission; exposes nothing else (no peer-signal path). */
class FakeSubmitter implements OutboxSubmitter {
  public readonly entries: OutboxEntryInput[] = [];
  constructor(private readonly nextId = 'outbox-1', private readonly fail = false) {}
  async submitOutbox(entry: OutboxEntryInput): Promise<string> {
    if (this.fail) throw new Error('temporal unavailable');
    this.entries.push(entry);
    return this.nextId;
  }
}

describe('Pi report tool — TypeBox schema', () => {
  it('builds an object schema with text (required) and type (optional)', () => {
    const schema = buildReportSchema() as {
      type: string;
      properties: Record<string, unknown>;
      required?: string[];
    };
    expect(schema.type).to.equal('object');
    expect(schema.properties).to.have.property('text');
    expect(schema.properties).to.have.property('type');
    expect(schema.required).to.deep.equal(['text']);
  });

  it('exposes the same report severities as the MCP report tool', () => {
    expect([...REPORT_TYPES]).to.deep.equal(['result', 'blocker', 'question', 'update']);
  });
});

describe('Pi report tool — handler routes through the outbox', () => {
  it('submits a ReportOutboxEntry with default type "result"', async () => {
    const submitter = new FakeSubmitter('outbox-42');
    const handler = createReportHandler(submitter);
    const result = await handler({ text: 'task done' });

    // Exactly one outbox submission — the ONLY cross-workflow path.
    expect(submitter.entries).to.have.length(1);
    const entry = submitter.entries[0] as { type: string; text: string; reportType: string };
    expect(entry.type).to.equal('report');
    expect(entry.text).to.equal('task done');
    expect(entry.reportType).to.equal('result');

    expect(result.isError).to.not.equal(true);
    expect(result.output).to.contain('outbox-42');
    expect(result.output).to.contain('[result]');
  });

  it('honors an explicit report type', async () => {
    const submitter = new FakeSubmitter();
    const handler = createReportHandler(submitter);
    await handler({ text: 'I am stuck', type: 'blocker' });
    const entry = submitter.entries[0] as { reportType: string };
    expect(entry.reportType).to.equal('blocker');
  });

  it('surfaces submit failures as an isError tool result (no throw)', async () => {
    const submitter = new FakeSubmitter('x', true);
    const handler = createReportHandler(submitter);
    const result = await handler({ text: 'will fail' });
    expect(result.isError).to.equal(true);
    expect(result.output).to.contain('Failed to send report');
  });
});

describe('Pi report tool — full Pi tool definition', () => {
  it('assembles name/description/parameters/execute', () => {
    const submitter = new FakeSubmitter();
    const def = buildReportToolDefinition(submitter);
    expect(def.name).to.equal('report');
    expect(def.description).to.be.a('string').and.have.length.greaterThan(0);
    expect(def.parameters).to.be.an('object');
    expect(def.execute).to.be.a('function');
  });

  it('execute() narrows Pi\'s untyped args and routes to the outbox', async () => {
    const submitter = new FakeSubmitter('ob-9');
    const def = buildReportToolDefinition(submitter);
    const result = await def.execute({ text: 'via execute', type: 'update' });
    expect(submitter.entries).to.have.length(1);
    const entry = submitter.entries[0] as { reportType: string; text: string };
    expect(entry.text).to.equal('via execute');
    expect(entry.reportType).to.equal('update');
    expect(result.output).to.contain('ob-9');
  });
});
