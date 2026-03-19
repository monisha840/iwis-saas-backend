import PDFDocument from 'pdfkit';
import { createObjectCsvWriter } from 'csv-writer';
import { createWriteStream } from 'fs';
import { join } from 'path';
import { mkdir } from 'fs/promises';

/**
 * Export service for generating CSV and PDF reports
 */
class ExportService {
    constructor() {
        this.exportDir = join(process.cwd(), 'exports');
        this.ensureExportDir();
    }

    async ensureExportDir() {
        try {
            await mkdir(this.exportDir, { recursive: true });
        } catch (error) {
            console.error('[ExportService] Failed to create export directory:', error);
        }
    }

    /**
     * Generate CSV file from data
     * @param {Array} data - Array of objects to export
     * @param {Array} headers - Column headers with id and title
     * @param {string} filename - Output filename
     * @returns {Promise<string>} Path to generated file
     */
    async generateCSV(data, headers, filename) {
        const filepath = join(this.exportDir, filename);

        const csvWriter = createObjectCsvWriter({
            path: filepath,
            header: headers,
        });

        await csvWriter.writeRecords(data);
        console.log(`[ExportService] CSV generated: ${filepath}`);
        return filepath;
    }

    /**
     * Generate PDF report
     * @param {Object} options - Report options
     * @param {string} options.title - Report title
     * @param {Array} options.data - Data to include
     * @param {Array} options.columns - Column definitions
     * @param {string} options.filename - Output filename
     * @returns {Promise<string>} Path to generated file
     */
    async generatePDF({ title, data, columns, filename, metadata = {} }) {
        const filepath = join(this.exportDir, filename);

        return new Promise((resolve, reject) => {
            const doc = new PDFDocument({ margin: 50 });
            const stream = createWriteStream(filepath);

            doc.pipe(stream);

            // Header
            doc
                .fontSize(20)
                .text(title, { align: 'center' })
                .moveDown();

            // Metadata
            if (metadata.generatedAt) {
                doc
                    .fontSize(10)
                    .text(`Generated: ${new Date(metadata.generatedAt).toLocaleString()}`, { align: 'right' });
            }
            if (metadata.dateRange) {
                doc.text(`Period: ${metadata.dateRange}`, { align: 'right' });
            }

            doc.moveDown(2);

            // Table
            if (data && data.length > 0) {
                const tableTop = doc.y;
                const itemHeight = 30;
                const columnWidth = (doc.page.width - 100) / columns.length;

                // Table headers
                doc.fontSize(12).fillColor('#4F46E5');
                columns.forEach((col, i) => {
                    doc.text(
                        col.header,
                        50 + i * columnWidth,
                        tableTop,
                        { width: columnWidth, align: 'left' }
                    );
                });

                doc.moveDown();
                doc.strokeColor('#E5E7EB').lineWidth(1);
                doc.moveTo(50, doc.y).lineTo(doc.page.width - 50, doc.y).stroke();

                // Table rows
                doc.fillColor('#000000').fontSize(10);
                data.forEach((row, index) => {
                    const y = tableTop + (index + 1) * itemHeight + 10;

                    // Check for page break
                    if (y > doc.page.height - 100) {
                        doc.addPage();
                        return;
                    }

                    columns.forEach((col, i) => {
                        const value = row[col.key] || '-';
                        doc.text(
                            String(value),
                            50 + i * columnWidth,
                            y,
                            { width: columnWidth, align: 'left' }
                        );
                    });

                    // Row separator
                    doc
                        .strokeColor('#F3F4F6')
                        .moveTo(50, y + 20)
                        .lineTo(doc.page.width - 50, y + 20)
                        .stroke();
                });
            } else {
                doc.fontSize(12).text('No data available', { align: 'center' });
            }

            // Footer
            const pages = doc.bufferedPageRange();
            for (let i = 0; i < pages.count; i++) {
                doc.switchToPage(i);
                doc
                    .fontSize(8)
                    .fillColor('#6B7280')
                    .text(
                        `Page ${i + 1} of ${pages.count}`,
                        50,
                        doc.page.height - 50,
                        { align: 'center' }
                    );
            }

            doc.end();

            stream.on('finish', () => {
                console.log(`[ExportService] PDF generated: ${filepath}`);
                resolve(filepath);
            });

            stream.on('error', reject);
        });
    }

    /**
     * Generate patient progress CSV export
     */
    async exportPatientProgress(data) {
        const headers = [
            { id: 'patientId', title: 'Patient ID' },
            { id: 'patientName', title: 'Patient Name' },
            { id: 'totalSessions', title: 'Total Sessions' },
            { id: 'completedSessions', title: 'Completed Sessions' },
            { id: 'progress', title: 'Progress (%)' },
            { id: 'lastSession', title: 'Last Session Date' },
            { id: 'status', title: 'Status' },
        ];

        const filename = `patient_progress_${Date.now()}.csv`;
        return await this.generateCSV(data, headers, filename);
    }

    /**
     * Generate appointments report CSV
     */
    async exportAppointments(data) {
        const headers = [
            { id: 'appointmentId', title: 'Appointment ID' },
            { id: 'patientName', title: 'Patient Name' },
            { id: 'doctorName', title: 'Doctor Name' },
            { id: 'date', title: 'Date' },
            { id: 'time', title: 'Time' },
            { id: 'status', title: 'Status' },
            { id: 'type', title: 'Type' },
        ];

        const filename = `appointments_${Date.now()}.csv`;
        return await this.generateCSV(data, headers, filename);
    }

    /**
     * Generate doctor performance PDF
     */
    async exportDoctorPerformance(data, metadata) {
        const columns = [
            { key: 'doctorName', header: 'Doctor Name' },
            { key: 'totalAppointments', header: 'Total Appointments' },
            { key: 'completedAppointments', header: 'Completed' },
            { key: 'cancelledAppointments', header: 'Cancelled' },
            { key: 'avgRating', header: 'Avg Rating' },
        ];

        const filename = `doctor_performance_${Date.now()}.pdf`;
        return await this.generatePDF({
            title: 'Doctor Performance Report',
            data,
            columns,
            filename,
            metadata,
        });
    }
}

export const exportService = new ExportService();
