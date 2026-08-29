import AssessmentWorkflow from "@/features/assessment/components/AssessmentWorkflow";
import { AssessmentProvider } from "@/features/assessment/store/AssessmentProvider";

export const metadata = { title: "Assessments · VedaAI" };

export default function AssessmentsPage() {
  return (
    <AssessmentProvider>
      <AssessmentWorkflow />
    </AssessmentProvider>
  );
}
