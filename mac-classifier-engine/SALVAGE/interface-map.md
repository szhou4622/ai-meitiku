# CPython 3.12 分类引擎接口地图

> 本文件由 `generate_archive.py` 从 15 个 `.pyc` 静态反汇编并在隔离进程中只做模块导入/反射生成。
> 带敏感名称的全局量只记录类型，不记录值；大型常量只记录数量和摘要。

## `xiaoguan_classifier.__init__`

- 字节码：`src/xiaoguan_classifier/__init__.pyc`
- SHA-256：`4a11901cac144a5cffe815e98e890b3dca3c3e0caa8f644e1fc5a6102a3e703e`
- 编译源路径：`xiaoguan_classifier\__init__.py`
- import 依赖：无

### 函数

- 无

### 类与方法

- 无

### 全局常量

- 无

## `xiaoguan_classifier.app`

- 字节码：`src/xiaoguan_classifier/app.pyc`
- SHA-256：`88e6dfcc97e4ed53468bc591858c59758c7649e4660469c90bd9363e63848659`
- 编译源路径：`xiaoguan_classifier\app.py`
- import 依赖：`__future__`, `config`, `dataclasses`, `help_docs`, `json`, `model_client`, `organizer`, `os`, `pathlib`, `queue`, `review_tools`, `rule_docs`, `shot_splitter`, `subprocess`, `templates`, `threading`, `time`, `tkinter`, `webbrowser`

### 函数

- `format_elapsed(seconds: 'float') -> 'str'`
- `looks_like_api_key(value: 'str') -> 'bool'`
- `main() -> 'None'`

### 类与方法

- `ApiConfigDialog(master: 'Tk')`
  - method `__init__(self, master: 'Tk')`
  - method `_build(self) -> 'None'`
  - method `_save(self) -> 'None'`
  - method `_test_text(self) -> 'None'`
  - method `_test_vision(self) -> 'None'`
- `App()`
  - method `__init__(self)`
  - method `_action_button(self, parent: 'Frame', text: 'str', command, variant: 'str' = 'secondary', width: 'int' = 12, state: 'str' = 'normal') -> 'Button'`
  - method `_apply_correction_sheet(self) -> 'None'`
  - method `_build(self) -> 'None'`
  - method `_card(self, parent: 'Frame', padx: 'int' = 18, pady: 'int' = 16) -> 'Frame'`
  - method `_choose_folder(self) -> 'None'`
  - method `_choose_output_folder(self) -> 'None'`
  - method `_compact_field_row(self, parent: 'Frame', label: 'str', variable: 'StringVar', button_text: 'str', command) -> 'None'`
  - method `_configure_styles(self) -> 'None'`
  - method `_confirm_classification_plan(self, folder: 'str', output_root: 'Path | None', config: 'ProviderConfig', review_only: 'bool' = False) -> 'bool'`
  - method `_confirmed_runtime_config(self) -> 'ProviderConfig | None'`
  - method `_create_correction_sheet(self) -> 'None'`
  - method `_current_library_root_for_tools(self) -> 'Path | None'`
  - method `_drain_queue(self) -> 'None'`
  - method `_edit_template(self) -> 'None'`
  - method `_effective_output_root_for_display(self, source_folder: 'str', output_root: 'Path | None') -> 'Path'`
  - method `_effective_split_output_root_for_display(self, source_folder: 'str', output_root: 'Path | None') -> 'Path'`
  - method `_ensure_activated(self) -> 'bool'`
  - method `_export_template(self) -> 'None'`
  - method `_field_row(self, parent: 'Frame', label: 'str', variable: 'StringVar', button_text: 'str', command) -> 'None'`
  - method `_import_template(self) -> 'None'`
  - method `_is_same_or_inside_folder(self, path: 'Path', folder: 'Path') -> 'bool'`
  - method `_log(self, message: 'str') -> 'None'`
  - method `_new_template(self) -> 'None'`
  - method `_open_classification_doc(self) -> 'None'`
  - method `_open_config(self) -> 'None'`
  - method `_open_outputs(self) -> 'None'`
  - method `_open_product_guide(self) -> 'None'`
  - method `_reload_templates(self, selected: 'ClassificationTemplate | None' = None) -> 'None'`
  - method `_run_classification_self_check(self) -> 'None'`
  - method `_run_worker(self, folder: 'Path', output_root: 'Path | None', template: 'ClassificationTemplate', config: 'ProviderConfig', review_only: 'bool' = False) -> 'None'`
  - method `_section_label(self, parent: 'Frame', title: 'str', subtitle: 'str' = '') -> 'None'`
  - method `_selected_output_root(self) -> 'Path | None'`
  - method `_set_running_state(self, running: 'bool') -> 'None'`
  - method `_set_status(self, text: 'str', detail: 'str' = '') -> 'None'`
  - method `_split_worker(self, folder: 'Path', output_root: 'Path | None') -> 'None'`
  - method `_start(self, review_only: 'bool' = False) -> 'None'`
  - method `_start_review_only(self) -> 'None'`
  - method `_start_split(self) -> 'None'`
  - method `_template_label(self, template: 'ClassificationTemplate') -> 'str'`
  - method `_template_saved(self, template: 'ClassificationTemplate') -> 'None'`
  - method `_template_selected(self, _event=None) -> 'None'`
  - method `_toggle_pause(self) -> 'None'`
- `ModelConfigPanel(master, config: 'ProviderConfig', description: 'str', include_efficiency: 'bool')`
  - method `__init__(self, master, config: 'ProviderConfig', description: 'str', include_efficiency: 'bool')`
  - method `_build(self, description: 'str') -> 'None'`
  - method `_provider_changed(self, _event=None) -> 'None'`
  - method `current_config(self, title: 'str') -> 'ProviderConfig | None'`
- `TemplateEditorDialog(master: 'Tk', template: 'ClassificationTemplate', on_saved)`
  - method `__init__(self, master: 'Tk', template: 'ClassificationTemplate', on_saved)`
  - method `_apply_ai_draft(self, draft: 'ClassificationTemplate') -> 'None'`
  - method `_build(self) -> 'None'`
  - method `_finish_ai_generation(self, job_id: 'int') -> 'None'`
  - method `_generate_with_ai(self) -> 'None'`
  - method `_parse_taxonomy(self) -> 'dict[str, list[str]]'`
  - method `_save(self) -> 'None'`
  - method `_show_ai_error(self, error_message: 'str') -> 'None'`
  - method `_taxonomy_to_text(self, taxonomy: 'dict[str, list[str]]') -> 'str'`
  - method `_tick_ai_status(self, job_id: 'int') -> 'None'`

### 全局常量

- `AI_INFO_TEMPLATE` = `'产品/项目名称：\n产品品类：\n分类目标：例如剪辑检索 / 投放素材库 / 达人素材沉淀 / 自有素材沉淀\n目标人群：\n\n核心痛点：\n1.\n2.\n3.\n\n核心卖点：\n1.\n2.\n3.\n\n常见使用/消费场景：\n1.\n2.\n3.\n\n必须单独成类的镜头：\n例如产品镜头、痛点镜头、使用镜头、卖点镜头、真人口播、达人素材、AI生成\n\n容易混淆的边界：\n例如试喝 vs 使用、达人口播 vs 真人口播、配料表 vs 配料干净低负担\n\n已有素材来源：\n自有拍摄 / 达人原片 / 产品图 / 直播切片 / AI生成 /…`
- `APP_BUILD_LABEL` = `'2026-08-03 21:20 复核纠错版'`
- `BOTH` = `'both'`
- `COLORS` = `{'bg': '#f4f6fa', 'card': '#ffffff', 'line': '#d8dde8', 'soft': '#eef3f9', 'text': '#172033', 'muted': '#6b7280', 'primary': '#1f4fd8', 'primary_hover': '#173ca5', 'dark': '#111827', 'dark_hover': '#374151', 'success_bg': '#e8f7ef', 'success': '#047857'}`
- `END` = `'end'`
- `FONT_BODY` = `('Microsoft YaHei UI', 9)`
- `FONT_BUTTON` = `('Microsoft YaHei UI', 10, 'bold')`
- `FONT_MUTED` = `('Microsoft YaHei UI', 9)`
- `FONT_SECTION` = `('Microsoft YaHei UI', 11, 'bold')`
- `FONT_TITLE` = `('Microsoft YaHei UI', 18, 'bold')`
- `LEFT` = `'left'`
- `MODE_LABELS` = `{'fast': '极速模式｜4-5帧，适合大量粗分', 'balanced': '稳准模式｜8帧左右，日常默认', 'refine': '精修模式｜10-12帧，重跑失败/待筛'}`
- `PROVIDER_LABELS` = `{'volcengine': '火山方舟 / 豆包'}`
- `RIGHT` = `'right'`
- `X` = `'x'`
- `Y` = `'y'`

## `xiaoguan_classifier.config`

- 字节码：`src/xiaoguan_classifier/config.pyc`
- SHA-256：`2205b530f7796bd623d03ca795f857e49bc4a741fe3e69e67a479519534910bf`
- 编译源路径：`xiaoguan_classifier\config.py`
- import 依赖：`__future__`, `dataclasses`, `json`, `os`, `pathlib`, `sys`

### 函数

- `_safe_bool(value: 'object', default: 'bool' = True) -> 'bool'`
- `_safe_mode(value: 'object') -> 'str'`
- `_settings_payload() -> 'dict[str, object]'`
- `get_provider_defaults(provider: 'str') -> 'ProviderConfig'`
- `has_usable_api_config() -> 'bool'`
- `has_usable_text_config() -> 'bool'`
- `load_api_key(config: 'ProviderConfig') -> 'str'`
- `load_settings() -> 'ProviderConfig'`
- `load_text_settings() -> 'ProviderConfig'`
- `parse_env_file(path: 'Path | None' = None) -> 'dict[str, str]'`
- `resolve_app_root() -> 'Path'`
- `save_api_key(env_name: 'str', api_key: 'str') -> 'None'`
- `save_settings(config: 'ProviderConfig', api_key: 'str | None' = None) -> 'None'`
- `save_text_settings(config: 'ProviderConfig', api_key: 'str | None' = None) -> 'None'`

### 类与方法

- `ProviderConfig(provider: 'str' = 'volcengine', base_url: 'str' = 'https://ark.cn-beijing.volces.com/api/v3', model: 'str' = '', api_key_env: 'str' = 'ARK_API_KEY', max_workers: 'int' = 4, frame_count: 'int' = 8, classification_mode: 'str' = 'balanced', smart_frames: 'bool' = True, auto_retry: 'bool' = False, max_tokens: 'int' = 500) -> None`
  - method `__eq__(self, other)`
  - method `__init__(self, provider: 'str' = 'volcengine', base_url: 'str' = 'https://ark.cn-beijing.volces.com/api/v3', model: 'str' = '', api_key_env: 'str' = 'ARK_API_KEY', max_workers: 'int' = 4, frame_count: 'int' = 8, classification_mode: 'str' = 'balanced', smart_frames: 'bool' = True, auto_retry: 'bool' = False, max_tokens: 'int' = 500) -> None`
  - method `__repr__(self)`

### 全局常量

- `APP_ROOT` = `'<engine-root>'`
- `CONFIG_DIR` = `'<engine-root>/config'`
- `ENV_PATH` = `'<engine-root>/.env.local'`
- `PROVIDER_DEFAULTS` = `{'volcengine': ProviderConfig(provider='volcengine', base_url='https://ark.cn-beijing.volces.com/api/v3', model='', api_key_env='ARK_API_KEY', max_workers=4, frame_count=8, classification_mode='balanced', smart_frames=True, auto_retry=False, max_tokens=500)}`
- `SETTINGS_PATH` = `'<engine-root>/config/settings.json'`

## `xiaoguan_classifier.help_docs`

- 字节码：`src/xiaoguan_classifier/help_docs.pyc`
- SHA-256：`2e4838e8d4ee76212eed524353325d7c15e7fc57b9d751810d773abc9a265ed3`
- 编译源路径：`xiaoguan_classifier\help_docs.py`
- import 依赖：`__future__`

### 函数

- `help_links() -> 'dict[str, str]'`

### 类与方法

- 无

### 全局常量

- `CLASSIFICATION_DOC_URL` = `'https://ecnyp4mrafm2.feishu.cn/docx/JTaEdJQ0goraL2xTx8ScFGNYnKb'`
- `FEISHU_DOC_URL` = `'https://ecnyp4mrafm2.feishu.cn/docx/JTaEdJQ0goraL2xTx8ScFGNYnKb'`
- `PRODUCT_GUIDE_DOC_URL` = `'https://fkm8bkhhkj.feishu.cn/wiki/V6Ycw1dwDiMwLak4lAtc1mu7nmf?from=from_copylink'`

## `xiaoguan_classifier.license_client`

- 字节码：`src/xiaoguan_classifier/license_client.pyc`
- SHA-256：`363eeb15af8cadaf4fab69e223b19adc7b77ec144d2840a30d689702397589fe`
- 编译源路径：`xiaoguan_classifier\license_client.py`
- import 依赖：`__future__`, `base64`, `ctypes`, `datetime`, `hashlib`, `json`, `os`, `pathlib`, `platform`, `re`, `subprocess`, `sys`, `threading`, `time`, `tkinter`, `urllib.error`, `urllib.request`, `uuid`, `webbrowser`

### 函数

- `_activation_window(reason: 'str', previous: 'dict[str, object] | None') -> 'bool'`
- `_as_bool(value: 'object') -> 'bool'`
- `_blob(data: 'bytes') -> 'tuple[DATA_BLOB, object]'`
- `_can_use_offline(state: 'dict[str, object]') -> 'bool'`
- `_check_update() -> 'dict[str, object]'`
- `_explicit_rejection(message: 'str', license_data: 'dict[str, object]') -> 'str'`
- `_first_text(source: 'object', *keys: 'str') -> 'str'`
- `_icon_path() -> 'Path'`
- `_license_payload(result: 'object') -> 'dict[str, object]'`
- `_load_state() -> 'dict[str, object] | None'`
- `_machine_source() -> 'str'`
- `_newer_version(left: 'object', right: 'object') -> 'bool'`
- `_parse_time(value: 'object') -> 'float | None'`
- `_protect(data: 'bytes') -> 'bytes'`
- `_request_activation(activation_code: 'str') -> 'tuple[int, dict[str, object]]'`
- `_save_state(state: 'dict[str, object]') -> 'None'`
- `_server_message(result: 'object', status: 'int' = 0) -> 'str'`
- `_state_directory() -> 'Path'`
- `_state_from_response(activation_code: 'str', result: 'dict[str, object]', previous: 'dict[str, object] | None') -> 'dict[str, object]'`
- `_summary(state: 'dict[str, object]') -> 'str'`
- `_unprotect(data: 'bytes') -> 'bytes'`
- `_utc_now() -> 'str'`
- `_validate_local(state: 'dict[str, object] | None') -> 'str'`
- `_version_parts(value: 'object') -> 'list[int]'`
- `activate_online(activation_code: 'str', previous: 'dict[str, object] | None' = None) -> 'dict[str, object]'`
- `ensure_activated() -> 'bool'`
- `license_path() -> 'Path'`
- `machine_code() -> 'str'`
- `schedule_update_check(root: 'object') -> 'None'`

### 类与方法

- `ConnectivityError<signature unavailable>`
- `DATA_BLOB<signature unavailable>`
- `LicenseError<signature unavailable>`
- `ServerRejectedError<signature unavailable>`

### 全局常量

- `ACTIVATE_URL` = `'https://license.dadaozixun.com/api/license/activate'`
- `APP_NAME` = `'DadaoMaterialClassifier'`
- `DISPLAY_NAME` = `'素材分类工作台'`
- `END` = `'end'`
- `LEFT` = `'left'`
- `OFFLINE_GRACE_SECONDS` = `259200`
- `REQUEST_TIMEOUT_SECONDS` = `12`
- `RIGHT` = `'right'`
- `SOFTWARE_VERSION` = `'0.1.0'`
- `TIME_ROLLBACK_TOLERANCE_SECONDS` = `300`
- `UPDATE_TIMEOUT_SECONDS` = `6`
- `UPDATE_URL` = `'https://update.dadaozixun.com/api/update/latest?app_name=DadaoMaterialClassifier'`
- `X` = `'x'`

## `xiaoguan_classifier.media`

- 字节码：`src/xiaoguan_classifier/media.pyc`
- SHA-256：`7b798eb4808c139b41d8cc225579bd3be37bbcc071aa8a18ae9ed9a141588401`
- 编译源路径：`xiaoguan_classifier\media.py`
- import 依赖：`PIL`, `__future__`, `base64`, `datetime`, `imageio.v2`, `imageio_ffmpeg`, `math`, `pathlib`, `re`, `subprocess`, `sys`, `typing`

### 函数

- `_filename_date(path: 'Path') -> 'tuple[str, str] | None'`
- `_frame_indices(fps: 'float', duration: 'float', frame_count: 'int') -> 'list[int]'`
- `_image_difference_score(previous: 'Image.Image', current: 'Image.Image') -> 'float'`
- `_image_exif_date(path: 'Path') -> 'tuple[str, str] | None'`
- `_parse_date_text(value: 'str') -> 'str | None'`
- `_save_compact_jpeg(image: 'Image.Image', output: 'Path', max_side: 'int' = 768) -> 'Path'`
- `_save_contact_sheet(images: 'list[Image.Image]', output: 'Path', cell_size: 'int' = 420, columns: 'int' = 4) -> 'Path'`
- `_smart_video_frames(reader, fps: 'float', duration: 'float', frame_count: 'int') -> 'list[Image.Image]'`
- `_unique_sorted_indices(values: 'list[int]', limit: 'int') -> 'list[int]'`
- `_video_metadata_date(path: 'Path') -> 'tuple[str, str] | None'`
- `encode_images_as_data_urls(paths: 'Iterable[Path]') -> 'list[str]'`
- `extract_video_contact_sheet(path: 'Path', work_dir: 'Path', frame_count: 'int' = 4, smart: 'bool' = True) -> 'list[Path]'`
- `extract_video_frames(path: 'Path', work_dir: 'Path', frame_count: 'int' = 4) -> 'list[Path]'`
- `material_shoot_date(path: 'Path') -> 'tuple[str, str, str]'`
- `prepare_image_payloads(path: 'Path', work_dir: 'Path') -> 'list[Path]'`
- `prepare_media_payloads(path: 'Path', work_dir: 'Path', frame_count: 'int' = 4, contact_sheet: 'bool' = True, smart_frames: 'bool' = True) -> 'list[Path]'`
- `scan_materials(folder: 'Path') -> 'list[Path]'`

### 类与方法

- 无

### 全局常量

- `IMAGE_EXTS` = `{'.jpg', '.jpeg', '.webp', '.png'}`
- `MEDIA_EXTS` = `{'.png', '.jpg', '.webp', '.mov', '.m4v', '.mp4', '.jpeg', '.avi'}`
- `VIDEO_EXTS` = `{'.mov', '.m4v', '.mp4', '.avi'}`

## `xiaoguan_classifier.model_client`

- 字节码：`src/xiaoguan_classifier/model_client.pyc`
- SHA-256：`d8d0152221c7aed132ee3961a8f992217266ac1f5da9353a67af071d310066ab`
- 编译源路径：`xiaoguan_classifier\model_client.py`
- import 依赖：`PIL`, `__future__`, `config`, `dataclasses`, `datetime`, `json`, `media`, `pathlib`, `prompt`, `re`, `requests`, `taxonomy`, `tempfile`, `templates`, `typing`

### 函数

- `_extract_json(text: 'str') -> 'dict[str, Any]'`
- `_failure_type(exc: 'BaseException | str') -> 'str'`
- `_limited_classification_tokens(config: 'ProviderConfig') -> 'int'`
- `_now_text() -> 'str'`
- `_post_chat_completion(config: 'ProviderConfig', headers: 'dict[str, str]', payload: 'dict[str, Any]') -> 'requests.Response'`
- `_safe_usage_int(value: 'Any') -> 'int'`
- `_usage_from_response(data: 'dict[str, Any]') -> 'tuple[int, int, int]'`
- `classify_material(config: 'ProviderConfig', image_paths: 'list[Path]', filename: 'str', source_hint: 'str' = '', template: 'Any | None' = None, request_logger: 'RequestLogger | None' = None, request_context: 'dict[str, Any] | None' = None) -> 'Classification'`
- `generate_template_draft(config: 'ProviderConfig', base_template: 'ClassificationTemplate', product_info: 'str') -> 'ClassificationTemplate'`
- `test_text_model_connection(config: 'ProviderConfig') -> 'str'`
- `test_vision_model_connection(config: 'ProviderConfig') -> 'Classification'`

### 类与方法

- `ModelClientError<signature unavailable>`

### 全局常量

- `CLASSIFIER_SYSTEM_PROMPT` = `'你是小罐茶浓萃乌龙素材库分类助手。请根据视频多帧抽帧拼图或图片画面，把素材归入固定分类。视频拼图从左到右是同一个镜头的连续关键帧。\n\n固定分类如下：\n00_待筛素材: 画面不明确或低相关\n01_痛点镜头: 上课备考犯困, 办公开会犯困, 午后工作犯困, 加班熬夜犯困, 通勤路上犯困, 开车出行犯困\n02_产品镜头: 瓶身展示, 整箱展示, 产品组合, 包装信息, 配料表, 营养成分, 活动机制, 产品空镜, 冰爽清冽, 液体质感\n03_使用镜头: 上课备考, 办公开会, 午后工位, 加班续航, 通勤外带, 开车出行, 冰饮畅饮\n04_卖点…`

## `xiaoguan_classifier.organizer`

- 字节码：`src/xiaoguan_classifier/organizer.pyc`
- SHA-256：`0f604e3cd965fc9ac261b67dab7a4605253a5498eae4886707dae86cf8abe51c`
- 编译源路径：`xiaoguan_classifier\organizer.py`
- import 依赖：`__future__`, `collections`, `concurrent.futures`, `config`, `csv`, `dataclasses`, `datetime`, `json`, `media`, `model_client`, `pathlib`, `re`, `shutil`, `source`, `taxonomy`, `templates`, `threading`, `typing`

### 函数

- `_append_resume_record(path: 'Path', row: 'dict[str, str]', operation: 'dict[str, str]', template: 'ClassificationTemplate') -> 'None'`
- `_classify_one(index: 'int', folder: 'Path', src: 'Path', work_dir: 'Path', config: 'ProviderConfig', template: 'ClassificationTemplate', request_logger: 'Callable[[dict[str, object]], None] | None' = None) -> 'dict[str, object]'`
- `_clean_prompt_filename(src: 'Path') -> 'str'`
- `_copy_classified_item(item: 'dict[str, object]', folder: 'Path', classification_root: 'Path', counters: 'defaultdict[tuple[str, str, str, str], int]', template: 'ClassificationTemplate') -> 'tuple[dict[str, str], dict[str, str]]'`
- `_effective_config(config: 'ProviderConfig') -> 'ProviderConfig'`
- `_emit(callback: 'ProgressCallback | None', message: 'str') -> 'None'`
- `_exclude_existing_category_dirs(materials: 'list[Path]', folder: 'Path', template: 'ClassificationTemplate') -> 'list[Path]'`
- `_exclude_nested_output_dirs(materials: 'list[Path]', folder: 'Path', *output_dirs: 'Path') -> 'list[Path]'`
- `_failed_row(index: 'int', folder: 'Path', src: 'Path', reason: 'str') -> 'dict[str, str]'`
- `_failure_type_from_error(error: 'object') -> 'str'`
- `_format_duration(started_at: 'datetime', ended_at: 'datetime') -> 'str'`
- `_is_pending_or_low_confidence(row: 'dict[str, str]') -> 'bool'`
- `_is_retryable_error(exc: 'Exception') -> 'bool'`
- `_is_retryable_pending_row(row: 'dict[str, str]') -> 'bool'`
- `_is_same_or_inside_folder(path: 'Path', folder: 'Path') -> 'bool'`
- `_load_resume_records(path: 'Path', template: 'ClassificationTemplate') -> 'dict[str, dict[str, object]]'`
- `_load_review_material_paths(outputs: 'Path', folder: 'Path') -> 'set[Path]'`
- `_looks_like_classification_root(path: 'Path', template: 'ClassificationTemplate') -> 'bool'`
- `_looks_like_classified_copy(path: 'Path') -> 'bool'`
- `_migrate_legacy_classification_root(legacy_root: 'Path', classification_root: 'Path', progress_callback: 'ProgressCallback | None' = None) -> 'None'`
- `_move_tree_contents(source: 'Path', destination: 'Path') -> 'tuple[int, int, int]'`
- `_prompt_source_hint(src: 'Path', source: 'object') -> 'str'`
- `_read_csv_rows(path: 'Path') -> 'list[dict[str, str]]'`
- `_resolve_library_root(folder: 'Path', output_root: 'Path | None') -> 'Path'`
- `_resolve_output_roots(library_root: 'Path', template: 'ClassificationTemplate') -> 'tuple[Path, Path]'`
- `_retry_config(config: 'ProviderConfig') -> 'ProviderConfig'`
- `_source_signature(path: 'Path') -> 'str'`
- `_unique_destination(dest_dir: 'Path', base_name: 'str') -> 'Path'`
- `_wait_if_paused(pause_event: 'Event | None', progress_callback: 'ProgressCallback | None' = None) -> 'None'`
- `_write_cleanup_script(path: 'Path', operations: 'list[dict[str, str]]') -> 'None'`
- `_write_csv(path: 'Path', rows: 'list[dict[str, str]]') -> 'None'`
- `_write_run_report(path: 'Path', summary: 'dict[str, object]') -> 'None'`
- `organize_folder(folder: 'Path', config: 'ProviderConfig', progress_callback: 'ProgressCallback | None' = None, output_root: 'Path | None' = None, pause_event: 'Event | None' = None, template: 'ClassificationTemplate | None' = None, review_only: 'bool' = False) -> 'dict[str, Path | int]'`
- `pending_classification(reason: 'str') -> 'Classification'`

### 类与方法

- 无

### 全局常量

- `CLASSIFICATION_NAME_NOISE` = `('待筛素材', '画面不明确或低相关', '模型识别失败待复核', '低置信度待人工复核', '处理失败', '文件处理失败')`
- `MODE_LABELS` = `{'fast': '极速模式', 'balanced': '稳准模式', 'refine': '精修模式'}`
- `RETRYABLE_FAILURE_MARKERS` = `('模型接口连接失败', 'Read timed out', 'read timeout', 'timed out', 'Could not load meta information', 'Output file does not contain any stream', 'ffmpeg', '抽帧失败', '没有可用抽帧')`

## `xiaoguan_classifier.prompt`

- 字节码：`src/xiaoguan_classifier/prompt.pyc`
- SHA-256：`52665f14af2c503d1075fd127a9c5fb1dbcba0bc4a459de87de5f718790a03c8`
- 编译源路径：`xiaoguan_classifier\prompt.py`
- import 依赖：`__future__`, `taxonomy`, `typing`

### 函数

- `system_prompt_for_template(template: 'Any') -> 'str'`
- `taxonomy_text() -> 'str'`
- `taxonomy_text_for(taxonomy: 'dict[str, list[str]]') -> 'str'`
- `user_prompt_for_material(filename: 'str', source_hint: 'str' = '') -> 'str'`

### 类与方法

- 无

### 全局常量

- `CLASSIFIER_SYSTEM_PROMPT` = `'你是小罐茶浓萃乌龙素材库分类助手。请根据视频多帧抽帧拼图或图片画面，把素材归入固定分类。视频拼图从左到右是同一个镜头的连续关键帧。\n\n固定分类如下：\n00_待筛素材: 画面不明确或低相关\n01_痛点镜头: 上课备考犯困, 办公开会犯困, 午后工作犯困, 加班熬夜犯困, 通勤路上犯困, 开车出行犯困\n02_产品镜头: 瓶身展示, 整箱展示, 产品组合, 包装信息, 配料表, 营养成分, 活动机制, 产品空镜, 冰爽清冽, 液体质感\n03_使用镜头: 上课备考, 办公开会, 午后工位, 加班续航, 通勤外带, 开车出行, 冰饮畅饮\n04_卖点…`
- `TAXONOMY` = `<dict items=10 sha256=26393142faa51a90>`

## `xiaoguan_classifier.review_tools`

- 字节码：`src/xiaoguan_classifier/review_tools.pyc`
- SHA-256：`627447866a679dc0786bcd3b0d1895526c6753c688da10164b3b6dd0c32ad119`
- 编译源路径：`xiaoguan_classifier\review_tools.py`
- import 依赖：`__future__`, `csv`, `datetime`, `pathlib`, `re`, `shutil`, `taxonomy`, `templates`, `typing`

### 函数

- `_correction_sheet_path(library_root: 'Path') -> 'Path'`
- `_is_pending_row(row: 'dict[str, str]') -> 'bool'`
- `_manifest_path(library_root: 'Path') -> 'Path'`
- `_next_sequence(dest_dir: 'Path', suffix: 'str') -> 'int'`
- `_normalize_manual_category(value: 'str', taxonomy: 'dict[str, list[str]]') -> 'str'`
- `_normalize_manual_form(value: 'str') -> 'str'`
- `_read_csv_rows(path: 'Path') -> 'list[dict[str, str]]'`
- `_row_key(row: 'dict[str, str]') -> 'str'`
- `_unique_destination(path: 'Path') -> 'Path'`
- `_write_csv(path: 'Path', rows: 'list[dict[str, str]]') -> 'None'`
- `_write_current_cleanup_script(path: 'Path', manifest_rows: 'list[dict[str, str]]') -> 'None'`
- `apply_correction_sheet(library_root: 'Path', template: 'ClassificationTemplate') -> 'dict[str, Any]'`
- `build_correction_sheet(library_root: 'Path', template: 'ClassificationTemplate') -> 'Path'`
- `run_classification_self_check(library_root: 'Path', template: 'ClassificationTemplate') -> 'dict[str, Any]'`

### 类与方法

- 无

### 全局常量

- `CORRECTION_FIELDS` = `('修正一级分类', '修正二级分类', '修正具体画面', '修正景别或形态')`
- `CORRECTION_LOG_NAME` = `'人工修正记录.csv'`
- `CORRECTION_SHEET_NAME` = `'人工修正表.csv'`
- `MANIFEST_NAME` = `'分类清单.csv'`
- `PENDING_NAME` = `'待筛清单.csv'`
- `SCENE_OR_FORM` = `['特写', '近景', '中景', '远景', '俯拍', '手持', '海报', '详情页', '截图', '空镜', '动效']`
- `SELF_CHECK_CSV_NAME` = `'分类自检报告.csv'`
- `SELF_CHECK_MD_NAME` = `'分类自检报告.md'`
- `UNSTABLE_REASON_MARKERS` = `('可能', '疑似', '不确定', '看不清', '无法', '不明显', '弱线索', '低置信')`

## `xiaoguan_classifier.rule_docs`

- 字节码：`src/xiaoguan_classifier/rule_docs.pyc`
- SHA-256：`e2b098b60c51750993b1f2403b21f8b901c7b2852046f05cee93a21b82dd2f61`
- 编译源路径：`xiaoguan_classifier\rule_docs.py`
- import 依赖：`__future__`, `config`, `html`, `pathlib`, `re`, `templates`

### 函数

- `_paragraphs(text: 'str') -> 'str'`
- `_safe_filename(value: 'str') -> 'str'`
- `_taxonomy_table(template: 'ClassificationTemplate') -> 'str'`
- `build_template_rule_doc(template: 'ClassificationTemplate') -> 'Path'`

### 类与方法

- 无

### 全局常量

- `CONFIG_DIR` = `'<engine-root>/config'`
- `RULE_DOC_DIR` = `'<engine-root>/config/rule_docs'`

## `xiaoguan_classifier.shot_splitter`

- 字节码：`src/xiaoguan_classifier/shot_splitter.pyc`
- SHA-256：`513e744d3244f6b09c392705820bbbabb8b3872bb001098d2e2820569958e2e7`
- 编译源路径：`xiaoguan_classifier\shot_splitter.py`
- import 依赖：`__future__`, `concurrent.futures`, `csv`, `dataclasses`, `datetime`, `imageio.v2`, `imageio_ffmpeg`, `media`, `os`, `pathlib`, `re`, `subprocess`, `sys`, `threading`, `typing`

### 函数

- `_friendly_ffmpeg_error(stderr: 'str') -> 'str'`
- `_hidden_subprocess_kwargs() -> 'dict[str, object]'`
- `_is_same_or_inside_folder(path: 'Path', folder: 'Path') -> 'bool'`
- `_resolve_outputs_root(folder: 'Path', output_root: 'Path | None') -> 'Path'`
- `_run_ffmpeg(command: 'list[str]') -> 'None'`
- `_safe_stamp(seconds: 'float') -> 'str'`
- `_wait_if_paused(pause_event: 'Event | None', progress_callback: 'ProgressCallback | None' = None) -> 'None'`
- `_write_failure_csv(output_root: 'Path', failures: 'list[SplitFailure]') -> 'Path | None'`
- `build_segments(cuts: 'list[float]', duration: 'float', min_segment_seconds: 'float' = 0.8) -> 'list[tuple[float, float]]'`
- `detect_scene_cuts(path: 'Path', threshold: 'float' = 0.24) -> 'list[float]'`
- `get_video_duration(path: 'Path') -> 'float'`
- `scan_videos(folder: 'Path') -> 'list[Path]'`
- `split_clip(input_path: 'Path', output_path: 'Path', start: 'float', end: 'float') -> 'None'`
- `split_folder_stable(folder: 'Path', progress_callback: 'ProgressCallback | None' = None, output_root: 'Path | None' = None, pause_event: 'Event | None' = None, video_workers: 'int' = 2) -> 'list[SplitResult]'`
- `split_video_stable(input_path: 'Path', output_root: 'Path', progress_callback: 'ProgressCallback | None' = None, pause_event: 'Event | None' = None, export_workers: 'int' = 2) -> 'SplitResult'`

### 类与方法

- `BatchSplitError(failures: 'list[SplitFailure]', failure_csv: 'Path | None' = None)`
  - method `__init__(self, failures: 'list[SplitFailure]', failure_csv: 'Path | None' = None)`
- `SplitFailure(source: 'Path', reason: 'str', detail: 'str') -> None`
  - method `__delattr__(self, name)`
  - method `__eq__(self, other)`
  - method `__hash__(self)`
  - method `__init__(self, source: 'Path', reason: 'str', detail: 'str') -> None`
  - method `__repr__(self)`
  - method `__setattr__(self, name, value)`
- `SplitResult(source: 'Path', output_dir: 'Path', segment_count: 'int') -> None`
  - method `__delattr__(self, name)`
  - method `__eq__(self, other)`
  - method `__hash__(self)`
  - method `__init__(self, source: 'Path', output_dir: 'Path', segment_count: 'int') -> None`
  - method `__repr__(self)`
  - method `__setattr__(self, name, value)`

### 全局常量

- `BATCH_VIDEO_WORKERS` = `2`
- `SPLIT_EXPORT_WORKERS` = `2`
- `STABLE_MIN_SEGMENT_SECONDS` = `0.8`
- `STABLE_SCENE_THRESHOLD` = `0.24`
- `VIDEO_EXTS` = `{'.mov', '.m4v', '.mp4', '.avi'}`

## `xiaoguan_classifier.source`

- 字节码：`src/xiaoguan_classifier/source.pyc`
- SHA-256：`7d42d82558a8fbc9b6dffe11321816da20260300f0e1ed75b8016a063a5285bf`
- 编译源路径：`xiaoguan_classifier\source.py`
- import 依赖：`__future__`, `dataclasses`, `pathlib`

### 函数

- `_clean_source_name(value: 'str', fallback: 'str', strip_markers: 'bool' = True) -> 'str'`
- `infer_source_info(root: 'Path', material: 'Path') -> 'SourceInfo'`

### 类与方法

- `SourceInfo(source_type: 'str', source_name: 'str', relative_path: 'str') -> None`
  - method `__delattr__(self, name)`
  - method `__eq__(self, other)`
  - method `__hash__(self)`
  - method `__init__(self, source_type: 'str', source_name: 'str', relative_path: 'str') -> None`
  - method `__repr__(self)`
  - method `__setattr__(self, name, value)`

### 全局常量

- `CREATOR_MARKERS` = `('达人', 'KOC', 'kol', 'KOL', '博主', '创作者')`
- `SELF_MARKERS` = `('自拍', '自有', '内部', '主播', '演员', '素人')`

## `xiaoguan_classifier.taxonomy`

- 字节码：`src/xiaoguan_classifier/taxonomy.pyc`
- SHA-256：`5eb286c7b1a375ba2d37fffa238b8d2b8e0854db79c38fd2a430df37aa4b1b5d`
- 编译源路径：`xiaoguan_classifier\taxonomy.py`
- import 依赖：`__future__`, `dataclasses`, `pathlib`, `typing`

### 函数

- `_safe_int(value: 'Any') -> 'int'`
- `build_material_filename(classification: 'Classification', date_code: 'str', sequence: 'int', suffix: 'str', source_name: 'str' = '', product_name: 'str' = '浓萃乌龙', taxonomy: 'dict[str, list[str]] | None' = None) -> 'str'`
- `is_category_dir(path: 'Path') -> 'bool'`
- `normalize_category(value: 'str', taxonomy: 'dict[str, list[str]] | None' = None) -> 'str'`
- `normalize_classification(raw: 'dict[str, Any] | Classification', taxonomy: 'dict[str, list[str]] | None' = None) -> 'Classification'`
- `safe_filename_part(value: 'str', fallback: 'str' = '未命名') -> 'str'`

### 类与方法

- `Classification(category: 'str', subcategory: 'str', detail: 'str', form: 'str', confidence: 'float', reason: 'str' = '', prompt_tokens: 'int' = 0, completion_tokens: 'int' = 0, total_tokens: 'int' = 0) -> None`
  - method `__delattr__(self, name)`
  - method `__eq__(self, other)`
  - method `__hash__(self)`
  - method `__init__(self, category: 'str', subcategory: 'str', detail: 'str', form: 'str', confidence: 'float', reason: 'str' = '', prompt_tokens: 'int' = 0, completion_tokens: 'int' = 0, total_tokens: 'int' = 0) -> None`
  - method `__repr__(self)`
  - method `__setattr__(self, name, value)`

### 全局常量

- `DEFAULT_DATE_FORMAT` = `'%y%m%d'`
- `PRODUCT_NAME` = `'浓萃乌龙'`
- `SCENE_OR_FORM` = `['特写', '近景', '中景', '远景', '俯拍', '手持', '海报', '详情页', '截图', '空镜', '动效']`
- `TAXONOMY` = `<dict items=10 sha256=26393142faa51a90>`

## `xiaoguan_classifier.templates`

- 字节码：`src/xiaoguan_classifier/templates.pyc`
- SHA-256：`38950d7389b9025c82a03a42ab883b0f95ba51d5a0b6e45b7f9a38c787d27677`
- 编译源路径：`xiaoguan_classifier\templates.py`
- import 依赖：`__future__`, `config`, `dataclasses`, `datetime`, `json`, `pathlib`, `taxonomy`, `typing`, `uuid`

### 函数

- `_now_text() -> 'str'`
- `builtin_templates() -> 'list[ClassificationTemplate]'`
- `clone_template(template: 'ClassificationTemplate', name: 'str', product_name: 'str') -> 'ClassificationTemplate'`
- `default_template() -> 'ClassificationTemplate'`
- `ensure_default_template() -> 'None'`
- `get_active_template() -> 'ClassificationTemplate'`
- `get_active_template_id() -> 'str'`
- `list_templates() -> 'list[ClassificationTemplate]'`
- `load_template(template_id: 'str') -> 'ClassificationTemplate'`
- `save_template(template: 'ClassificationTemplate') -> 'None'`
- `set_active_template_id(template_id: 'str') -> 'None'`
- `template_from_dict(data: 'dict[str, Any]') -> 'ClassificationTemplate'`
- `template_path(template_id: 'str') -> 'Path'`

### 类与方法

- `ClassificationTemplate(template_id: 'str', name: 'str', product_name: 'str', taxonomy: 'dict[str, list[str]]', rules: 'str' = '', naming_rule: 'str' = '产品名_二级分类_具体画面_景别_素材拍摄日期_序号', updated_at: 'str' = '') -> None`
  - method `__delattr__(self, name)`
  - method `__eq__(self, other)`
  - method `__hash__(self)`
  - method `__init__(self, template_id: 'str', name: 'str', product_name: 'str', taxonomy: 'dict[str, list[str]]', rules: 'str' = '', naming_rule: 'str' = '产品名_二级分类_具体画面_景别_素材拍摄日期_序号', updated_at: 'str' = '') -> None`
  - method `__repr__(self)`
  - method `__setattr__(self, name, value)`

### 全局常量

- `ACTIVE_TEMPLATE_PATH` = `'<engine-root>/config/active_template.json'`
- `CONFIG_DIR` = `'<engine-root>/config'`
- `DEFAULT_TEMPLATE_ID` = `'xiaoguan-default'`
- `PRODUCT_NAME` = `'浓萃乌龙'`
- `TAXONOMY` = `<dict items=10 sha256=26393142faa51a90>`
- `TEMPLATE_DIR` = `'<engine-root>/config/templates'`
