import { useState } from 'react';
import {
  Github,
  ExternalLink,
  Heart,
  Code2,
  Lightbulb,
  Bug,
} from 'lucide-react';
import { BugReportDialog } from '@/components/common/BugReportDialog';
import { Button } from '@/components/ui/button';
import { PROJECT_REPOSITORY, PROJECT_URL } from '../../utils/brand';

export function AboutSection() {
  const [showBugReport, setShowBugReport] = useState(false);

  return (
    <div className="space-y-6">
      {/* 项目信息 */}
      <div>
        <h2 className="text-lg font-semibold text-foreground mb-1">
          SKUHarbor
        </h2>
        <p className="text-sm text-muted-foreground">跨境电商运营 Copilot</p>
        <p className="mt-1 text-xs text-muted-foreground">
          版本 1.0.0 · MIT License
        </p>
        <p className="mt-2 text-xs text-muted-foreground leading-relaxed">
          基于{' '}
          <a
            href="https://github.com/helsome/OpenDot"
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary hover:text-primary/80"
          >
            OpenDot
          </a>{' '}
          二次开发，保留上游版权声明与 MIT 许可证，复用 Pi Runtime 底座。
        </p>
      </div>

      {/* 开源地址 & 作者 & 报告问题 */}
      <div className="space-y-3">
        <div className="flex items-center gap-3">
          <Github className="w-4 h-4 text-muted-foreground shrink-0" />
          <a
            href={PROJECT_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-primary hover:text-primary/80 inline-flex items-center gap-1"
          >
            {PROJECT_REPOSITORY}
            <ExternalLink className="w-3 h-3" />
          </a>
        </div>
        <div className="flex items-center gap-3">
          <Code2 className="w-4 h-4 text-muted-foreground shrink-0" />
          <span className="text-sm text-foreground">项目维护：icearia0219</span>
        </div>
        <div className="flex items-center gap-3">
          <Bug className="w-4 h-4 text-muted-foreground shrink-0" />
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowBugReport(true)}
          >
            <Bug className="w-3.5 h-3.5" />
            报告问题
          </Button>
        </div>
      </div>

      <BugReportDialog
        open={showBugReport}
        onClose={() => setShowBugReport(false)}
      />

      <hr className="border-border" />

      {/* 灵感来源 */}
      <div>
        <div className="flex items-center gap-2 mb-3">
          <Lightbulb className="w-4 h-4 text-amber-500" />
          <h3 className="text-sm font-medium text-foreground">灵感来源</h3>
        </div>
        <div className="space-y-4 text-sm text-muted-foreground">
          <div>
            <a
              href="https://github.com/slopus/happy"
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:text-primary/80 font-medium inline-flex items-center gap-1"
            >
              Happy
              <ExternalLink className="w-3 h-3" />
            </a>
            <p className="mt-1 leading-relaxed">
              Claude Code Web
              化方向的重要启发项目，让用户可以通过浏览器在不同设备上继续使用
              Claude Code 工作流。
            </p>
          </div>
          <div>
            <a
              href="https://github.com/openclaw/openclaw"
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:text-primary/80 font-medium inline-flex items-center gap-1"
            >
              OpenClaw
              <ExternalLink className="w-3 h-3" />
            </a>
            <p className="mt-1 leading-relaxed">
              自托管个人智能体产品方向的重要参考。SKUHarbor 复用 OpenDot 与 Pi
              Runtime 底座，增加电商任务、证据和人工审核流程。
            </p>
          </div>
        </div>
      </div>

      <hr className="border-border" />

      {/* 设计哲学 */}
      <div>
        <div className="flex items-center gap-2 mb-3">
          <Heart className="w-4 h-4 text-rose-500" />
          <h3 className="text-sm font-medium text-foreground">设计哲学</h3>
        </div>
        <p className="text-sm text-muted-foreground leading-relaxed">
          复用成熟底座，把商品事实、适用规则、质检与人工审核放进可追溯的运营流程。
        </p>
      </div>
    </div>
  );
}
