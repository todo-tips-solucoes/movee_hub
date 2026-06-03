'use client';

import { XmlValidationCard } from '@/components/xml-validation-card';
import { motion } from 'framer-motion';

export default function ValidacaoXmlPage() {
  return (
    <motion.div
      className="flex h-full flex-col gap-4"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.3 }}
    >
      <XmlValidationCard />
    </motion.div>
  );
}
