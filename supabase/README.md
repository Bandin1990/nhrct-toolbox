# ตั้งค่าฐานข้อมูล Supabase

1. เปิดโปรเจกต์ `uervlfkcqzasodbpfyos` ใน Supabase Dashboard
2. ไปที่ **SQL Editor → New query**
3. เปิดไฟล์ `001_nhrc_workhub_schema.sql` แล้วคัดลอกทั้งหมดไปวาง
4. กด **Run** และตรวจสอบว่าไม่มีข้อความ Error
5. ไปที่ **Table Editor** ควรเห็นตาราง `documents`, `document_chunks`, `work_categories`, `questions` และ `answer_citations`

สคริปต์นี้ไม่ลบตารางหรือข้อมูลเดิม ใช้ `if not exists` และเพิ่ม RLS ให้ตารางที่เปิดผ่าน Data API

## ข้อควรรู้

- ไฟล์เอกสารจริงเก็บใน Storage bucket ชื่อ `reference-documents` แบบ private
- การอัปโหลดและแก้ไขเอกสารให้ทำผ่าน backend เท่านั้น
- ระบบจะตอบจาก `document_chunks` และอ้างอิงกลับไปที่ `documents`
- คอลัมน์ embedding ตั้งไว้ 1536 มิติ เพื่อใช้กับ `gemini-embedding-2` หากเปลี่ยนโมเดลต้องปรับ dimension ให้ตรงกัน

## Gemini RAG

ระบบใช้ `gemini-embedding-2` ขนาด 1536 มิติสำหรับ chunks และใช้ `gemini-3.6-flash` เรียบเรียงคำตอบจากหลักฐานที่ค้นพบเท่านั้น

หลังใส่ `GEMINI_API_KEY` ใน `.env` ให้รัน:

```powershell
node scripts/embed-supabase-gemini.js
```

ระบบถามจะค้นด้วย vector จาก Supabase ก่อน แล้วส่งเฉพาะหลักฐานที่พบให้ Gemini พร้อมหมายเลขอ้างอิง
## สิทธิ์ผู้ใช้งาน

- ผู้ใช้ทั่วไป: ถามผู้ช่วย อ่านเอกสาร และเปิดต้นฉบับ
- ผู้ดูแลระบบ: แก้ไขชื่อ/เนื้อหา นำเข้าเอกสาร และซิงก์ฐานข้อมูล
- กำหนดผู้ดูแลด้วย `ADMIN_EMAILS` ใน `.env` หรือกำหนด `app_metadata.role=admin` ใน Supabase Auth
- ห้ามใช้ `user_metadata` เป็นตัวตัดสินสิทธิ์
