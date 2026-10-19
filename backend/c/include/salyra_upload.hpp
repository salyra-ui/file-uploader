#ifndef SALYRA_UPLOAD_HPP
#define SALYRA_UPLOAD_HPP
#include "salyra_upload.h"
#include <memory>
#include <stdexcept>
#include <string>
namespace salyra {
struct json_deleter {
  void operator()(char *value) const noexcept { upload_free(value); }
};
using json = std::unique_ptr<char, json_deleter>;
struct engine_deleter {
  void operator()(upload_engine *engine) const noexcept {
    upload_engine_free(engine);
  }
};
struct disk_deleter {
  void operator()(upload_disk *disk) const noexcept { upload_disk_free(disk); }
};
using disk = std::unique_ptr<upload_disk, disk_deleter>;
class upload_exception : public std::runtime_error {
public:
  const int status;
  const std::string code;
  explicit upload_exception(const upload_error &error)
      : std::runtime_error(error.message ? error.message
                                         : "Upload operation failed"),
        status(error.status), code(error.code ? error.code : "UPLOAD") {}
};
class engine {
  std::unique_ptr<upload_engine, engine_deleter> value_;
  static json checked(int status, char *result, const upload_error &error) {
    json owned(result);
    if (status)
      throw upload_exception(error);
    return owned;
  }

public:
  explicit engine(const upload_options &options)
      : value_(upload_engine_new(&options)) {
    if (!value_)
      throw std::invalid_argument("Invalid upload options");
  }
  engine(engine &&) noexcept = default;
  engine &operator=(engine &&) noexcept = default;
  engine(const engine &) = delete;
  engine &operator=(const engine &) = delete;
  json create(const std::string &descriptor, const std::string &key,
              void *context = nullptr) {
    char *result = nullptr;
    upload_error error{};
    int status = upload_create(value_.get(), descriptor.c_str(), key.c_str(),
                               context, &result, &error);
    return checked(status, result, error);
  }
  json probe(const std::string &id, void *context = nullptr) {
    char *result = nullptr;
    upload_error error{};
    int status =
        upload_probe(value_.get(), id.c_str(), context, &result, &error);
    return checked(status, result, error);
  }
  json part(const std::string &id, int index, const std::string &checksum,
            upload_read reader, void *body, void *context = nullptr) {
    char *result = nullptr;
    upload_error error{};
    int status = upload_part(value_.get(), id.c_str(), index, checksum.c_str(),
                             reader, body, context, &result, &error);
    return checked(status, result, error);
  }
  json finish(const std::string &id, void *context = nullptr) {
    char *result = nullptr;
    upload_error error{};
    int status =
        upload_finish(value_.get(), id.c_str(), context, &result, &error);
    return checked(status, result, error);
  }
  json cancel(const std::string &id, void *context = nullptr) {
    char *result = nullptr;
    upload_error error{};
    int status =
        upload_cancel(value_.get(), id.c_str(), context, &result, &error);
    return checked(status, result, error);
  }
};
} // namespace salyra
#endif
